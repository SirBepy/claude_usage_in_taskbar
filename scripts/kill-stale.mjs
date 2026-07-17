// Pre-dev cleanup: free Vite's port 1420 so `cargo tauri dev` can start
// cleanly.
//
// Used to also taskkill any running `claude-conductor.exe` / "Claude
// Conductor.exe" by name so cargo's fresh dev build could reclaim the shared
// daemon port/pipe/lock. That's gone (incident 2026-07-16: it killed the
// user's real installed app, mid-use, every time dev started). The debug
// build now gets its own daemon identity by default (see
// `daemon::instance::instance_suffix`), so it never needs to evict prod to
// start - the installed app is never a "stale" process to clean up here.
import { execSync } from 'node:child_process';

if (process.platform !== 'win32') process.exit(0);

const quiet = (cmd) => {
  try { execSync(cmd, { stdio: 'ignore', windowsHide: true }); } catch {}
};

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
  if (pids.size > 0) {
    await new Promise(r => setTimeout(r, 600));
  }
} catch {}
