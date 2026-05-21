// UI smoke: the app boots its SPA shell and the Sessions view renders with the
// daemon connected. Chat correctness itself is covered headlessly by the daemon
// integration tests (src-tauri/tests/daemon_chat_e2e.rs); this layer only proves
// the webview wiring renders.

describe("Claude Companion UI smoke", () => {
  it("boots the dashboard SPA shell", async () => {
    const sidemenu = await $("#sidemenu");
    await sidemenu.waitForExist({ timeout: 30000 });
    await expect(sidemenu).toExist();
  });

  it("renders the Sessions view sidebar (daemon connected)", async () => {
    // window.showView is exposed globally by src/shared/navigation.ts. The
    // Sessions view is not in the sidemenu, so navigate to it directly.
    await browser.execute(() => window.showView("sessions"));

    const view = await $(".view-sessions");
    await view.waitForExist({ timeout: 15000 });

    // The sidebar list container (template.ts: <ul id="sessions-list">) is the
    // stable marker that the Sessions view mounted.
    const list = await $("#sessions-list");
    await list.waitForExist({ timeout: 15000 });
    await expect(list).toExist();
  });
});
