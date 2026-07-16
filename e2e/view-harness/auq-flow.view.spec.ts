import { test, expect } from "@playwright/test";
import { mountView } from "./harness";

// AUQ multi-question flow (Joe's request 2026-07-16): a footer CTA that reads
// "Next" until the last question, then flips to a review-and-Send summary
// screen, instead of a single always-disabled-until-everything's-answered
// "Submit" button. Exercises renderQuestionUI directly (dynamic import of the
// dev-served module) so no session/composer mount or daemon is needed -
// ensureHost() falls back to a viewport-fixed card when neither
// .session-composer nor .session-pane exist in the DOM.

declare global {
  interface Window {
    __auqResult?: { submitted?: Record<string, string | string[]>; cancelled?: boolean };
    __auqDraftChanges?: Array<{ freeText: [number, string][]; selections: [number, string | string[]][]; activeTab: number }>;
  }
}

async function openCard(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(async () => {
    const mod = await import("/views/sessions/permission-modal/question-ui.ts");
    window.__auqResult = {};
    window.__auqDraftChanges = [];
    mod.renderQuestionUI({
      questions: [
        {
          question: "Which approach?",
          header: "Approach",
          options: [{ label: "A" }, { label: "B" }],
        },
        {
          question: "Which features?",
          header: "Features",
          multiSelect: true,
          options: [{ label: "X" }, { label: "Y" }],
        },
        {
          question: "Anything else?",
          header: "Notes",
          options: [{ label: "Nope" }],
        },
      ],
      titleIcon: "ph-chat-circle-dots",
      titleText: "Claude is asking",
      submitLabel: "Submit",
      submitIcon: "ph-paper-plane-right",
      cancelLabel: "Skip",
      onSubmit: (answers) => { window.__auqResult!.submitted = answers; },
      onCancel: () => { window.__auqResult!.cancelled = true; },
      // Maps/Sets don't structured-clone across the page.evaluate boundary
      // cleanly for later inspection, so flatten to plain arrays here.
      onDraftChange: (draft) => {
        window.__auqDraftChanges!.push({
          freeText: Array.from(draft.freeText.entries()),
          selections: Array.from(draft.selections.entries()).map(([k, v]) => [k, v instanceof Set ? Array.from(v) : v]),
          activeTab: draft.activeTab,
        });
      },
    });
  });
}

test.describe("view-harness / AUQ Next -> Review -> Send flow", () => {
  test("typing a free-text answer (no option click) still advances via Next", async ({ page }) => {
    await mountView(page);
    await openCard(page);

    const card = page.locator(".prompt-card");
    await expect(card).toBeVisible();
    await expect(card.locator(".prompt-q__text")).toHaveText("Which approach?");

    // The exact bug: answer via free text, no option click, no way to advance
    // before this change. Now the footer button reads "Next" and works.
    const primaryBtn = card.locator('[data-act="next"], [data-act="review"], [data-act="submit"]');
    await expect(primaryBtn).toHaveText(/Next/);
    await card.locator(".prompt-q__other-input").fill("Go with plan A, typed not clicked");
    await primaryBtn.click();

    await expect(card.locator(".prompt-q__text")).toHaveText("Which features?");
  });

  test("Ctrl+Enter advances like clicking the primary CTA", async ({ page }) => {
    await mountView(page);
    await openCard(page);

    const card = page.locator(".prompt-card");
    const textarea = card.locator(".prompt-q__other-input");
    await textarea.fill("answered via keyboard");
    await textarea.press("Control+Enter");

    await expect(card.locator(".prompt-q__text")).toHaveText("Which features?");
  });

  test("last question's CTA reads Review, leads to a recap screen, Send disabled until all answered", async ({ page }) => {
    await mountView(page);
    await openCard(page);

    const card = page.locator(".prompt-card");

    // Q1: answered via free text, not an option click - explicit Next (an
    // option click auto-advances PAST Q2, since a multiSelect with zero
    // selections already counts as "answered"; using Next keeps this
    // deterministic and is exactly the path under test).
    await card.locator(".prompt-q__other-input").fill("A (typed)");
    await card.locator('[data-act="next"]').click();
    await expect(card.locator(".prompt-q__text")).toHaveText("Which features?");

    // Q2 (multiSelect): check one box, click Next.
    await card.locator('.prompt-opt input[data-label="X"]').check();
    await card.locator('[data-act="next"]').click();
    await expect(card.locator(".prompt-q__text")).toHaveText("Anything else?");

    // Q3 is last: CTA reads Review, not Submit - answered via free text again.
    const lastBtn = card.locator('[data-act="review"]');
    await expect(lastBtn).toHaveText(/Review/);
    await card.locator(".prompt-q__other-input").fill("nothing else");
    await lastBtn.click();

    // Now on the summary screen.
    const rows = card.locator(".prompt-summary-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0).locator(".prompt-summary-row__answer")).toHaveText("A (typed)");
    await expect(rows.nth(1).locator(".prompt-summary-row__answer")).toHaveText("X");
    await expect(rows.nth(2).locator(".prompt-summary-row__answer")).toHaveText("nothing else");

    const sendBtn = card.locator('[data-act="submit"]');
    await expect(sendBtn).toBeEnabled();

    // Back returns to the answer view at the last question, editable.
    await card.locator('[data-act="back"]').click();
    await expect(card.locator(".prompt-q__text")).toHaveText("Anything else?");

    // Re-enter summary and actually send.
    await card.locator('[data-act="review"]').click();
    await card.locator('[data-act="submit"]').click();

    const result = await page.evaluate(() => window.__auqResult);
    expect(result?.submitted).toEqual({
      "Which approach?": "A (typed)",
      "Which features?": ["X"],
      "Anything else?": "nothing else",
    });
    await expect(card).toHaveCount(0);
  });

  test("clicking a summary row jumps straight to editing that question", async ({ page }) => {
    await mountView(page);
    await openCard(page);

    const card = page.locator(".prompt-card");
    await card.locator(".prompt-q__other-input").fill("A");
    await card.locator('[data-act="next"]').click();
    await card.locator('.prompt-opt input[data-label="X"]').check();
    await card.locator('[data-act="next"]').click();
    await card.locator(".prompt-q__other-input").fill("done");
    await card.locator('[data-act="review"]').click();

    await card.locator(".prompt-summary-row").nth(1).click();
    await expect(card.locator(".prompt-q__text")).toHaveText("Which features?");
    // Landed back in answer mode, not the last question, so CTA is Next again.
    await expect(card.locator('[data-act="next"]')).toBeVisible();
  });

  test("Next/Review is disabled on the current question until it's answered", async ({ page }) => {
    await mountView(page);
    await openCard(page);

    const card = page.locator(".prompt-card");
    const nextBtn = card.locator('[data-act="next"]');
    // Q1 untouched: nothing selected, nothing typed - can't proceed yet.
    await expect(nextBtn).toBeDisabled();
    // .click(), not .check(): checking this radio auto-advances to Q2 as part
    // of the same synchronous change handler, replacing the DOM the instant
    // it's clicked - .check()'s post-click "is it checked now" assertion would
    // chase a node that's already gone.
    await card.locator('.prompt-opt input[data-label="A"]').click();
    // Auto-advanced to Q2, still unanswered there (nothing picked yet), so
    // Next is freshly disabled again rather than staying enabled.
    await expect(card.locator(".prompt-q__text")).toHaveText("Which features?");
    await expect(nextBtn).toBeDisabled();
  });

  test("multiSelect: checking a real option or 'None of the above' or typing free text all unlock Next; None is exclusive", async ({ page }) => {
    await mountView(page);
    await openCard(page);

    const card = page.locator(".prompt-card");
    await card.locator(".prompt-q__other-input").fill("A");
    await card.locator('[data-act="next"]').click();
    await expect(card.locator(".prompt-q__text")).toHaveText("Which features?");

    const nextBtn = card.locator('[data-act="next"]');
    const noneBox = card.locator('.prompt-opt input[data-label="None of the above"]');
    const xBox = card.locator('.prompt-opt input[data-label="X"]');
    await expect(noneBox).toBeVisible();
    await expect(nextBtn).toBeDisabled();

    // A real option unlocks Next.
    await xBox.check();
    await expect(nextBtn).toBeEnabled();

    // "None of the above" is exclusive: picking it clears the real option, and
    // is itself a valid, proceed-unlocking answer.
    await noneBox.check();
    await expect(xBox).not.toBeChecked();
    await expect(nextBtn).toBeEnabled();

    // Picking a real option again clears None back out.
    await xBox.check();
    await expect(noneBox).not.toBeChecked();
    await expect(nextBtn).toBeEnabled();

    // Unchecking the only selection re-locks Next; free text alone also
    // unlocks it, with nothing checked.
    await xBox.uncheck();
    await expect(nextBtn).toBeDisabled();
    await card.locator(".prompt-q__other-input").fill("actually, something else entirely");
    await expect(nextBtn).toBeEnabled();
  });

  test("Send stays disabled on the summary screen while a question is unanswered", async ({ page }) => {
    await mountView(page);
    await openCard(page);

    const card = page.locator(".prompt-card");
    // Jump straight to the last question via its tab, answer only that one,
    // then Review - Q1 and Q2 are reachable but never answered.
    await card.locator('.prompt-tab[data-tab="2"]').click();
    await card.locator(".prompt-q__other-input").fill("handled");
    await card.locator('[data-act="review"]').click();

    await expect(card.locator(".prompt-summary-row.is-unanswered")).toHaveCount(2);
    await expect(card.locator('[data-act="submit"]')).toBeDisabled();
  });

  test("onDraftChange fires with the live draft as the user types and advances (persistence + chat-sync feed off this)", async ({ page }) => {
    await mountView(page);
    await openCard(page);

    const card = page.locator(".prompt-card");
    // Fires once on the initial render too, with an empty draft - except Q2
    // (multiSelect) gets a pre-seeded empty Set so its checkboxes have
    // something to mutate, per the existing multiSelect init in renderQuestionUI.
    let changes = await page.evaluate(() => window.__auqDraftChanges);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.at(-1)).toEqual({ freeText: [], selections: [[1, []]], activeTab: 0 });

    await card.locator(".prompt-q__other-input").fill("A (typed)");
    changes = await page.evaluate(() => window.__auqDraftChanges);
    expect(changes.at(-1)).toEqual({ freeText: [[0, "A (typed)"]], selections: [[1, []]], activeTab: 0 });

    await card.locator('[data-act="next"]').click();
    changes = await page.evaluate(() => window.__auqDraftChanges);
    // Advancing re-renders, so activeTab moves to 1 with the same freeText kept.
    expect(changes.at(-1)).toEqual({ freeText: [[0, "A (typed)"]], selections: [[1, []]], activeTab: 1 });

    await card.locator('.prompt-opt input[data-label="X"]').check();
    changes = await page.evaluate(() => window.__auqDraftChanges);
    expect(changes.at(-1)).toEqual({ freeText: [[0, "A (typed)"]], selections: [[1, ["X"]]], activeTab: 1 });
  });
});
