// Integration coverage for ai_todo 53: the inline edit-window + changes panel
// (rail, sheet, dim, reviewed) wired into the REAL session pane. The render
// logic itself is unit-tested headlessly (tests/edit-window.test.mjs,
// changes-panel.test.mjs, chat-renderer-edits.test.mjs); this layer proves the
// active-session pane actually mounts the panel and routes ChatRenderer
// callbacks to the DOM.
//
// FREE: seeds a session via the `register_historical` daemon RPC (no `claude`
// process, no billed turn) and injects synthetic file-edit tool_use events via
// the dev-only `window.__injectEdit` seam (main.ts, stripped from prod builds).
// The live activity bar is gated on a busy turn, so it stays a manual eyeball
// (its callback is covered by chat-renderer-edits.test.mjs) and is not asserted
// here.
//
// Opt-in (spawns no claude but seeds the harness daemon's registry):
//   npm run test:e2e:changes

const SESSION_ID = `e2e-changes-${Date.now()}`;

async function seedSession(cwd) {
  await browser.execute(async (sessionId, sessionCwd) => {
    await window.__TAURI__.core.invoke("register_historical_session", {
      sessionId,
      cwd: sessionCwd,
      accountId: "e2e-seeded-account",
    });
  }, SESSION_ID, cwd);
}

async function injectEdit(opts) {
  await browser.execute((sessionId, o) => {
    window.__injectEdit(sessionId, o);
  }, SESSION_ID, opts);
}

describe("Changes panel + inline edit-window (ai_todo 53)", () => {
  before(async () => {
    await browser.execute(() => window.showView("sessions"));
    // Seed an Interactive session in the daemon registry so a clickable sidebar
    // row appears. Use this repo's root as cwd so no throwaway project is
    // created (it is already a known project).
    await seedSession(process.cwd());

    const row = await $(`#sessions-list li[data-session-id="${SESSION_ID}"]`);
    await row.waitForExist({ timeout: 15000 });
    await row.click();

    // Pane mounted: renderer attached + changes-btn present.
    await (await $(".session-messages")).waitForExist({ timeout: 15000 });
    await (await $(".session-header .changes-btn")).waitForExist({ timeout: 15000 });
  });

  after(async () => {
    // Clean up the seeded session so it doesn't linger as live in the registry.
    await browser.execute(async (sessionId) => {
      try {
        await window.__TAURI__.core.invoke("clear_session", { sessionId });
      } catch { /* best effort */ }
    }, SESSION_ID);
  });

  it("renders an inline edit-window for an Edit tool_use, collapsed by default", async () => {
    await injectEdit({
      tool: "Edit",
      file: "src/demo/alpha.ts",
      oldText: "const a = 1;",
      newText: "const a = 2;",
    });

    const win = await $(".session-messages .edit-window");
    await win.waitForExist({ timeout: 10000 });
    // Collapsed: <details> has no `open` attribute yet.
    expect(await win.getAttribute("open")).toBe(null);
    expect(await (await $(".edit-window .edit-window-path")).getText()).toContain("alpha.ts");
  });

  it("expands to show side-by-side before/after columns", async () => {
    const summary = await $(".edit-window .edit-window-summary");
    await summary.click();

    const before = await $('.edit-window .edit-window-side[data-side="before"]');
    const after = await $('.edit-window .edit-window-side[data-side="after"]');
    await before.waitForExist({ timeout: 5000 });
    await after.waitForExist({ timeout: 5000 });
    expect(await before.getText()).toContain("const a = 1;");
    expect(await after.getText()).toContain("const a = 2;");
  });

  it("opens the changes rail (dimming the chat) listing every edited file", async () => {
    // Add a second file so the rail shows two deduped rows.
    await injectEdit({
      tool: "Write",
      file: "src/demo/beta.ts",
      content: "export const b = true;",
    });

    await (await $(".session-header .changes-btn")).click();

    const rail = await $(".changes-rail");
    await rail.waitForExist({ timeout: 10000 });

    const dimmed = await $(".session-messages.chat--dimmed");
    expect(await dimmed.isExisting()).toBe(true);

    const rows = await $$(".changes-rail .changes-row");
    expect(rows.length).toBe(2);
    expect(await (await $(".changes-rail-chip")).getText()).toBe("0 of 2 reviewed");
  });

  it("checking a row's reviewed box increments the chip", async () => {
    const firstCheckbox = await $(".changes-rail .changes-row .changes-row-reviewed");
    await firstCheckbox.click();
    // Rail re-renders; chip reflects 1 reviewed.
    await browser.waitUntil(
      async () => (await (await $(".changes-rail-chip")).getText()) === "1 of 2 reviewed",
      { timeout: 5000, timeoutMsg: "chip did not increment after reviewing a row" }
    );
  });

  it("clicking a file row opens the sheet overlay, and it closes again", async () => {
    await (await $(".changes-rail .changes-row .changes-row-name")).click();

    const sheet = await $(".changes-sheet");
    await sheet.waitForExist({ timeout: 5000 });
    // Sheet body shows the stacked diff for that file.
    expect(await (await $(".changes-sheet-body")).getText()).toContain("a = 1;");

    await (await $(".changes-sheet-close")).click();
    await sheet.waitForExist({ timeout: 5000, reverse: true });
  });
});
