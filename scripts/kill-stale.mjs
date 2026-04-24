// Pre-dev cleanup: kill any running Claude Usage instance (prod or dev)
// and free Vite's port 1420 so `cargo tauri dev` can start cleanly.
import { execSync } from 'node:child_process';

const quiet = (cmd) => {
  try { execSync(cmd, { stdio: 'ignore', windowsHide: true }); } catch {}
};

if (process.platform !== 'win32') process.exit(0);

quiet('taskkill /F /T /IM "Claude Usage.exe"');
quiet('taskkill /F /T /IM "claude-usage-tauri.exe"');

try {
  const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', windowsHide: true });
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    if (!/[:.]1420\s/.test(line)) continue;
    const m = line.trim().match(/(\d+)\s*$/);
    if (m && m[1] !== '0') pids.add(m[1]);
  }
  for (const pid of pids) quiet(`taskkill /F /PID ${pid}`);
} catch {}
