// UI coverage for the multi-account feature's three remaining unverified
// surfaces (milestone 08, docs/multi-account/08-notifications-polish.md item
// 3c): the dashboard account selector (milestone 05), the new-chat account
// picker (milestone 04), and the floating overlay (milestone 06).
//
// WRITTEN, NOT YET RUN. Per the milestone-08 brief this spec was authored and
// parse/type-checked (`pnpm tsc --noEmit` covers .ts specs; this file is
// plain .js so only `node --check` syntax-validates it) but deliberately not
// executed against the harness in this session. Whoever picks this up next
// should run it via the opt-in npm script below, fix whatever the first real
// run surfaces, and only then consider it "verified".
//
//   npm run test:e2e:accounts
//
// FREE in the billing sense (no `claude` process spawned), but NOT fixture-
// free: the harness's `wdio` daemon instance starts with an EMPTY accounts
// registry (no wizard has ever run against it), and the wizard's `/login`
// step cannot be scripted (00-overview.md, locked decision) - there is no
// IPC seam to fabricate a fake registered account the way `changes-panel.
// e2e.js` seeds a fake session via `register_historical_session`. So:
//
//   - The dashboard + new-chat-picker specs below assert the well-defined
//     EMPTY-registry path (deterministic, matches the harness's real state).
//     A future update that adds a lightweight "seed account" test-only IPC
//     command (mirroring `__injectEdit`'s dev-only seam in main.ts) could
//     extend these to the populated (`.dash-acard` / account-chip) path.
//   - The overlay lives in a SEPARATE always-on-top Tauri window
//     (`session-overlay`, `index.html?overlaywindow=1`) built only from
//     `ipc::window::toggle_overlay_window`, which is a plain Rust fn wired to
//     the tray icon's real OS click - NOT an invokable `#[tauri::command]`.
//     There is no scripted way to open it from the webview. The spec below
//     documents this and instead asserts the one thing reachable from here:
//     the overlay's data dependencies (`list_accounts` + `get_usage_map`)
//     round-trip cleanly over IPC, which is what `renderOverlay` awaits
//     before it paints anything (`src/views/overlay/overlay.ts`). The
//     overlay's own render logic is already unit-tested headlessly
//     (`tests/overlay-logic.test.mjs`); true window-level coverage needs
//     either a tray-click automation layer or a dedicated
//     `open_overlay_window_for_test` command - out of this milestone's scope.

describe("Dashboard account selector (multi-account milestone 05)", () => {
  it("renders the legacy stat cards, not the account-selector row, with an empty registry", async () => {
    await browser.execute(() => window.showView("dashboard"));

    const content = await $("#stats-content");
    await content.waitForExist({ timeout: 15000 });

    // No accounts registered in this harness -> `accountsCache.length === 0`
    // -> `renderShell` falls back to `legacyStatCardsHtml`, never the
    // `.dash-sel-row` / `.dash-acard` selector cards (dashboard.ts:
    // `renderShell`'s `cardsHtml` ternary).
    const selectorRow = await $(".dash-sel-row");
    await expect(selectorRow).not.toExist();
  });

  it("surfaces the one-time 'set up your accounts' banner only when a legacy session exists", async () => {
    // Harness-dependent: the banner needs BOTH an empty registry (true here)
    // AND a legacy `session.txt` on disk (`should_show_setup_prompt`). The
    // wdio harness's app-data dir may or may not have one depending on
    // whether a prior manual login ever ran against it - so this assertion
    // is a structural existence check, not a hard true/false expectation.
    const banner = await $("#dashSetupBanner");
    const exists = await banner.isExisting();
    if (exists) {
      await expect($(".dash-setup-banner-cta")).toExist();
      await expect($(".dash-setup-banner-dismiss")).toExist();
    }
  });
});

describe("New-chat account picker (multi-account milestone 04)", () => {
  it("shows the 'no accounts yet' state in the model/effort modal with an empty registry", async () => {
    await browser.execute(() => window.showView("sessions"));
    const newSessionBtn = await $("#newSessionBtn");
    await newSessionBtn.waitForExist({ timeout: 15000 });
    // `#newSessionBtn` starts disabled until the sessions view finishes its
    // initial data load (template.ts: `disabled` in the static markup).
    await newSessionBtn.waitForEnabled({ timeout: 15000 });
    await newSessionBtn.click();

    // `triggerNewSessionGlobal` opens a project picker before the model/
    // effort modal when no pane is attached yet (session-controls.ts). Prefer
    // whichever surfaces first, then drive into the modal if a picker showed.
    const projectPickerItem = await $("[data-project-path]");
    if (await projectPickerItem.isExisting()) {
      await projectPickerItem.click();
    }

    const accField = await $(".me-acc-field");
    await accField.waitForExist({ timeout: 15000 });
    // Empty-registry state (model-effort-modal.ts `renderAccountFieldHtml`):
    // a warning message + "Add one in Settings" link, never the chip picker.
    await expect($(".me-acc-empty")).toExist();
    await expect($(".me-acc-add-link")).toExist();
    await expect($("[data-acc-id]")).not.toExist();
  });
});

describe("Overlay data dependencies (multi-account milestone 06)", () => {
  it("list_accounts + get_usage_map round-trip cleanly (what renderOverlay awaits before painting)", async () => {
    const result = await browser.execute(async () => {
      const [accounts, usageMap] = await Promise.all([
        window.__TAURI__.core.invoke("list_accounts"),
        window.__TAURI__.core.invoke("get_usage_map"),
      ]);
      return { accountsIsArray: Array.isArray(accounts), usageMapIsObject: typeof usageMap === "object" && usageMap !== null };
    });
    expect(result.accountsIsArray).toBe(true);
    expect(result.usageMapIsObject).toBe(true);
  });

  // NOT automated (see file header): opening the actual `session-overlay`
  // window requires a real tray-icon click, which has no scripted IPC path.
  it.skip("overlay window renders .oc-panel with account rows - needs a tray-click automation seam or a test-only open command", () => {});
});
