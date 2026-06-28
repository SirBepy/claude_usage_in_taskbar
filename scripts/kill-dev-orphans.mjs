// One-shot cleanup of all dev processes spawned by `cargo tauri dev`.
// Safe to run after Ctrl-C or a crash. Never touches the installed release app
// or unrelated shells/nodes.
//
// Targets (in kill order):
//   claude-conductor.exe --daemon  (daemon child of the debug app)
//   cc-conductor-daemon.exe          (standalone daemon exe)
//   claude-conductor.exe           (main debug app)
//   cargo-tauri.exe                  (tauri CLI process)
//   node.exe with this project's vite in CommandLine
//   claude.exe --remote-control      (channel bridge spawned by the daemon)
//
// Then removes a stale daemon.lock if its recorded PID is no longer alive.

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { env } from 'node:process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('kill-dev-orphans: Windows only, skipping.');
  process.exit(0);
}

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..');

const quiet = (cmd) => {
  try { execSync(cmd, { stdio: 'ignore', windowsHide: true }); } catch {}
};

// Run PowerShell and return stdout. Uses double-quoted -Command; only use
// single quotes inside the script string to avoid cmd.exe quoting conflicts.
function ps(script) {
  try {
    return execSync(`powershell -NoProfile -Command "${script}"`, {
      encoding: 'utf8', windowsHide: true,
    });
  } catch {
    return '';
  }
}

// PIDs for processes matching exeName whose CommandLine contains cliFragment.
// cliFragment must be safe inside PS single-quoted string (no single quotes).
function pidsByCommandLine(exeName, cliFragment) {
  const script =
    `Get-CimInstance Win32_Process | ` +
    `Where-Object { $_.Name -eq '${exeName}' -and $_.CommandLine -match '${cliFragment}' } | ` +
    `Select-Object -ExpandProperty ProcessId`;
  return ps(script).split(/\r?\n/).map(l => l.trim()).filter(l => /^\d+$/.test(l));
}

// PIDs for all processes with the given exe name.
function pidsByName(exeName) {
  const script =
    `Get-CimInstance Win32_Process | ` +
    `Where-Object { $_.Name -eq '${exeName}' } | ` +
    `Select-Object -ExpandProperty ProcessId`;
  return ps(script).split(/\r?\n/).map(l => l.trim()).filter(l => /^\d+$/.test(l));
}

let killed = 0;

function killPid(pid) {
  quiet(`taskkill /F /T /PID ${pid}`);
  killed++;
}

// Escape backslashes for a PowerShell single-quoted regex string.
const projEscaped = projectRoot.replace(/\\/g, '\\\\');

// 1. Daemon child: claude-conductor.exe with --daemon flag.
for (const pid of pidsByCommandLine('claude-conductor.exe', '--daemon')) killPid(pid);

// 2. Standalone daemon exe.
for (const pid of pidsByName('cc-conductor-daemon.exe')) killPid(pid);

// 3. Main debug app (after daemon so /T cleans its subtree first).
for (const pid of pidsByName('claude-conductor.exe')) killPid(pid);

// 4. cargo-tauri CLI.
for (const pid of pidsByName('cargo-tauri.exe')) killPid(pid);

// 5. node.exe running vite for this project specifically.
for (const pid of pidsByCommandLine('node.exe', `vite.*${projEscaped}|${projEscaped}.*vite`)) killPid(pid);

// 6. claude.exe bridge started with --remote-control by the daemon.
for (const pid of pidsByCommandLine('claude.exe', '--remote-control')) killPid(pid);

// 7. Stale daemon.lock: remove if the recorded PID is gone.
const lockPath = join(env.APPDATA ?? '', 'claude-conductor', 'daemon.lock');
if (existsSync(lockPath)) {
  try {
    const lockPid = readFileSync(lockPath, 'utf8').trim();
    const alive = ps(`Get-Process -Id ${lockPid} -ErrorAction SilentlyContinue`).trim();
    if (!alive) {
      unlinkSync(lockPath);
      console.log(`Removed stale daemon.lock (pid ${lockPid} gone).`);
    } else {
      console.log(`daemon.lock pid ${lockPid} still alive — lock left in place.`);
    }
  } catch {
    // Unreadable or corrupt — remove since we just killed everything.
    try { unlinkSync(lockPath); console.log('Removed corrupt daemon.lock.'); } catch {}
  }
}

console.log(`kill-dev-orphans: ${killed} process tree(s) terminated.`);
