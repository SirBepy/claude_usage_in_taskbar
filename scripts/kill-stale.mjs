// Pre-dev cleanup: kill any STALE Claude Usage instance (prod or dev)
// and free Vite's port 1420 so `cargo tauri dev` can start cleanly.
//
// IMPORTANT: cargo runs the new binary in parallel with this script. With
// a cached build the new exe is already running by the time we get here,
// so taskkill /IM "claude-usage-tauri.exe" would terminate the brand-new
// instance (exit code 1, no panic). We filter by process start time and
// only kill instances older than the grace window.
import { execSync } from 'node:child_process';

if (process.platform !== 'win32') process.exit(0);

const GRACE_SECONDS = 15;

const quiet = (cmd) => {
  try { execSync(cmd, { stdio: 'ignore', windowsHide: true }); } catch {}
};

function listStalePids(processName) {
  // Get-Process -Name takes the exe name without .exe.
  const baseName = processName.replace(/\.exe$/i, '');
  // Quote with single quotes to keep PowerShell happy with names containing spaces.
  const ps = `Get-Process -Name '${baseName}' -ErrorAction SilentlyContinue | ` +
             `ForEach-Object { '{0},{1}' -f $_.Id, [int64]$_.StartTime.ToFileTimeUtc() }`;
  let out = '';
  try {
    out = execSync(`powershell -NoProfile -Command "${ps}"`, {
      encoding: 'utf8', windowsHide: true,
    });
  } catch {
    return [];
  }
  // FileTime epoch (1601) → ms since 1970 = ft / 10000 - 11644473600000.
  const cutoffMs = Date.now() - GRACE_SECONDS * 1000;
  const pids = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+),(-?\d+)$/);
    if (!m) continue;
    const pid = m[1];
    const ft = Number(m[2]);
    const startMs = Math.floor(ft / 10000) - 11644473600000;
    if (startMs < cutoffMs) pids.push(pid);
  }
  return pids;
}

const stalePids = new Set();
for (const exe of ['claude-usage-tauri.exe', 'Claude Usage.exe']) {
  for (const p of listStalePids(exe)) stalePids.add(p);
}
for (const pid of stalePids) quiet(`taskkill /F /T /PID ${pid}`);

// Free port 1420 (Vite). Vite hasn't started yet at this point, so any
// holder is stale by definition.
try {
  const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', windowsHide: true });
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    if (!/[:.]1420\s/.test(line)) continue;
    const m = line.trim().match(/(\d+)\s*$/);
    if (m && m[1] !== '0') pids.add(m[1]);
  }
  for (const pid of pids) quiet(`taskkill /F /PID ${pid}`);
  if (stalePids.size > 0 || pids.size > 0) {
    await new Promise(r => setTimeout(r, 600));
  }
} catch {}
