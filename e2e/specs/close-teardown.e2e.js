// BILLED UI regression for ai_todo 147: `/close` actually tears the chat down
// via the REAL skill markers, not the old "typed text contains /close"
// heuristic. Sends a genuine `/close` turn to the daemon-hosted `claude`
// process and asserts the sidebar row is fully removed once the skill's
// turn settles. Also covers the two false-positive/no-teardown edges that
// motivated the marker rewrite (see close-finalize.ts):
//   - prose that merely mentions "/close" never promotes the row.
//   - `/close --dont-close` promotes the row to "closing" then reverts it
//     to normal (no removal) once the turn settles.
//
// Spawns real `claude` turns (tiny, subscription-billed). Run explicitly:
//   npm run test:e2e:close

async function sidebarSessionIds() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll("#sessions-list li[data-session-id]"))
      .map((li) => li.getAttribute("data-session-id"))
  );
}

async function rowClasses(sessionId) {
  return browser.execute(
    (id) => document.querySelector(`#sessions-list li[data-session-id="${id}"]`)?.className ?? null,
    sessionId
  );
}

async function startNewChatPickingFirstProject() {
  // New chat lives in the view-header "more options" overflow menu.
  const moreBtn = await $("#viewMoreBtn");
  await moreBtn.waitForClickable({ timeout: 15000 });
  await moreBtn.click();
  const newBtn = await $("#newSessionBtn");
  await newBtn.waitForClickable({ timeout: 15000 });
  await newBtn.click();
  // 1. Project picker -> pick the first project.
  const row = await $(".project-picker-row");
  await row.waitForExist({ timeout: 10000 });
  await row.click();
  // 2. Model/effort modal -> Start session with defaults.
  const confirm = await $(".me-confirm");
  await confirm.waitForClickable({ timeout: 10000 });
  await confirm.click();
  // 3. Pending pane mounts the composer.
  await (await $(".composer-textarea")).waitForExist({ timeout: 20000 });
}

async function sendMessage(text) {
  const ta = await $(".composer-textarea");
  await ta.waitForExist({ timeout: 10000 });
  await ta.setValue(text);
  await (await $(".composer-send")).click();
}

async function activeSessionId() {
  return browser.execute(() =>
    document.querySelector("#sessions-list li.active")?.getAttribute("data-session-id") ?? null
  );
}

async function waitForAssistantFinal(target, timeout = 120000) {
  await browser.waitUntil(
    async () =>
      (await browser.execute(
        () => document.querySelectorAll(".msg.assistant:not(.streaming)").length
      )) >= target,
    { timeout, interval: 1000, timeoutMsg: `assistant-final never reached ${target}` }
  );
}

describe("/close teardown (ai_todo 147, real skill markers)", () => {
  before(async () => {
    await browser.execute(() => window.showView("sessions"));
  });

  it("prose merely mentioning /close never marks the row closing", async () => {
    await startNewChatPickingFirstProject();
    const id = await activeSessionId();
    expect(id).toBeTruthy();

    await sendMessage("Please explain what a //close bracket is in regex, don't run anything.");
    await waitForAssistantFinal(1);

    // Give the (non-existent) close watcher a moment to have promoted the
    // row if it were going to - it never should, since no real /close ran.
    await browser.pause(1000);
    const cls = await rowClasses(id);
    expect(cls).not.toContain("closing");
    expect((await sidebarSessionIds())).toContain(id);
  });

  it("/close --dont-close marks the row closing then reverts it (no teardown)", async () => {
    await startNewChatPickingFirstProject();
    const id = await activeSessionId();
    expect(id).toBeTruthy();

    await sendMessage("/close --dont-close --skip-review");

    // The skill's own <cc-close:starting> marker should promote the row
    // before the turn settles.
    await browser.waitUntil(
      async () => (await rowClasses(id))?.includes("closing"),
      { timeout: 60000, interval: 1000, timeoutMsg: "row never promoted to closing for /close --dont-close" }
    );

    // Once the turn settles without <cc-close:done>, the row must revert to
    // normal and the session must still be present (not torn down).
    await browser.waitUntil(
      async () => {
        const cls = await rowClasses(id);
        return cls !== null && !cls.includes("closing");
      },
      { timeout: 120000, interval: 1000, timeoutMsg: "row never reverted to normal after /close --dont-close settled" }
    );
    expect((await sidebarSessionIds())).toContain(id);
  });

  it("a real /close removes the session from the sidebar once the skill turn settles", async () => {
    await startNewChatPickingFirstProject();
    const id = await activeSessionId();
    expect(id).toBeTruthy();
    expect((await sidebarSessionIds())).toContain(id);

    await sendMessage("/close --skip-review");

    // <cc-close:starting> promotes the row first.
    await browser.waitUntil(
      async () => (await rowClasses(id))?.includes("closing"),
      { timeout: 60000, interval: 1000, timeoutMsg: "row never promoted to closing for real /close" }
    );

    // <cc-close:done> + settle -> finalize() tears the session down: the row
    // is removed from the sidebar entirely (not merely reverted).
    await browser.waitUntil(
      async () => !(await sidebarSessionIds()).includes(id),
      { timeout: 120000, interval: 1000, timeoutMsg: "session row never removed after real /close finished" }
    );
  });
});
