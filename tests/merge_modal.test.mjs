// The merge modal is reused for both merge and hide actions. Before this
// fix the confirm button text was hard-coded to "Merge" in dashboard.html,
// which made the Hide flow look like it was offering to merge. Guard that
// the modal helper sets the button label from the caller-supplied string.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";

const __dirname = dirname(fileURLToPath(import.meta.url));
const statsSrc = readFileSync(
  join(__dirname, "..", "dist", "modules", "stats.js"),
  "utf8"
);

function setup() {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <div id="merge-modal" style="display:none">
        <p id="merge-modal-text"></p>
        <button id="merge-confirm-btn">Merge</button>
        <button id="merge-cancel-btn">Cancel</button>
      </div>
    </body></html>`,
    { runScripts: "dangerously" }
  );
  // stats.js references a bunch of globals from other modules. Only
  // showMergeModal + hideMergeModal are needed here, so stub the rest by
  // isolating the helper via eval of just the two functions.
  const helper = statsSrc.match(/function showMergeModal[\s\S]+?\n\}\n\nfunction hideMergeModal[\s\S]+?\n\}/);
  expect(helper).not.toBeNull();
  const s = dom.window.document.createElement("script");
  s.textContent = helper[0];
  dom.window.document.body.appendChild(s);
  return dom;
}

describe("showMergeModal confirm label", () => {
  it("uses the provided label for Hide action (no more 'Merge' CTA)", () => {
    const dom = setup();
    const { showMergeModal } = dom.window;
    showMergeModal("Hide this project?", () => {}, null, "Hide");
    const btn = dom.window.document.getElementById("merge-confirm-btn");
    expect(btn.textContent).toBe("Hide");
  });

  it("defaults to 'Merge' when no label is provided (legacy callers keep working)", () => {
    const dom = setup();
    const { showMergeModal } = dom.window;
    showMergeModal("Merge into other?", () => {});
    const btn = dom.window.document.getElementById("merge-confirm-btn");
    expect(btn.textContent).toBe("Merge");
  });

  it("clicking confirm runs the onConfirm callback", () => {
    const dom = setup();
    const { showMergeModal } = dom.window;
    let fired = 0;
    showMergeModal("test", () => { fired++; }, null, "OK");
    dom.window.document.getElementById("merge-confirm-btn").click();
    expect(fired).toBe(1);
  });
});
