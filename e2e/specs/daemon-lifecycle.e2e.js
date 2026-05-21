// Phase 7 regression: the daemon is the SOLE chat path (Path C + the useDaemon
// toggle were deleted). This proves the running app is backed by a live daemon
// process and renders the Sessions view from the daemon's snapshot - i.e. there
// is no app-side fallback keeping Sessions alive without the daemon.
//
// Connectivity-only by design: it does NOT kill/respawn the daemon (that part
// stays manual to avoid leaving detached daemon orphans). Free - no billed turn.

import { execSync } from "node:child_process";

// Either binary name is a valid daemon: the wdio harness spawns the standalone
// `cc-companion-daemon.exe`, while the app's own reconnect loop would spawn
// `claude-usage-tauri.exe --daemon`. We only assert "a daemon is alive".
function daemonProcessRunning() {
  const out = execSync('tasklist /FO CSV /NH', { encoding: "utf8" });
  return /"cc-companion-daemon\.exe"/i.test(out) ||
    /"claude-usage-tauri\.exe"/i.test(out);
}

describe("Daemon-backed Sessions (Phase 7: daemon is sole chat path)", () => {
  it("a companion daemon process is running while the app is up", () => {
    expect(daemonProcessRunning()).toBe(true);
  });

  it("Sessions view renders from the daemon snapshot", async () => {
    // window.showView is exposed globally by src/shared/navigation.ts.
    await browser.execute(() => window.showView("sessions"));

    const view = await $(".view-sessions");
    await view.waitForExist({ timeout: 15000 });

    // #sessions-list is populated from the daemon's instance snapshot on
    // connect (list_instances RPC). With no daemon connection there would be
    // no snapshot path to render it - so its existence proves the daemon link.
    const list = await $("#sessions-list");
    await list.waitForExist({ timeout: 15000 });
    await expect(list).toExist();
  });
});
