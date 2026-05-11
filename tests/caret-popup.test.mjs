// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { CaretSuggestPopup } from "../src/shared/chat/caret-popup/popup.ts";

function setup() {
  const anchor = document.createElement("div");
  const ta = document.createElement("textarea");
  anchor.appendChild(ta);
  document.body.appendChild(anchor);
  const items = ["commit", "caveman", "close"];
  const provider = {
    triggerChar: "/",
    shouldTrigger: ({ textBefore }) => /(^|\n)\/[^\s]*$/.test(textBefore),
    query: (token) => items.filter((i) => i.startsWith(token.slice(1))),
    renderRow: (i, sel) => {
      const el = document.createElement("div");
      el.textContent = (sel ? "> " : "  ") + i;
      el.className = sel ? "row selected" : "row";
      return el;
    },
    onPick: vi.fn(),
  };
  const popup = new CaretSuggestPopup({ anchor, textarea: ta, provider });
  return { popup, ta, provider };
}

describe("CaretSuggestPopup", () => {
  it("opens on '/' at start of textarea", () => {
    const { popup, ta } = setup();
    ta.value = "/c";
    ta.selectionStart = ta.selectionEnd = 2;
    popup.handleInput();
    expect(popup.isOpen()).toBe(true);
  });

  it("does not open mid-line", () => {
    const { popup, ta } = setup();
    ta.value = "hello /c";
    ta.selectionStart = ta.selectionEnd = 8;
    popup.handleInput();
    expect(popup.isOpen()).toBe(false);
  });

  it("opens after newline", () => {
    const { popup, ta } = setup();
    ta.value = "hello\n/c";
    ta.selectionStart = ta.selectionEnd = 8;
    popup.handleInput();
    expect(popup.isOpen()).toBe(true);
  });

  it("closes when whitespace ends the token", () => {
    const { popup, ta } = setup();
    ta.value = "/c";
    ta.selectionStart = ta.selectionEnd = 2;
    popup.handleInput();
    expect(popup.isOpen()).toBe(true);
    ta.value = "/c ";
    ta.selectionStart = ta.selectionEnd = 3;
    popup.handleInput();
    expect(popup.isOpen()).toBe(false);
  });

  it("handleKey returns false when closed", () => {
    const { popup } = setup();
    const e = new KeyboardEvent("keydown", { key: "Enter" });
    expect(popup.handleKey(e)).toBe(false);
  });

  it("Enter picks selected item when open", () => {
    const { popup, ta, provider } = setup();
    ta.value = "/c";
    ta.selectionStart = ta.selectionEnd = 2;
    popup.handleInput();
    const e = new KeyboardEvent("keydown", { key: "Enter" });
    expect(popup.handleKey(e)).toBe(true);
    expect(provider.onPick).toHaveBeenCalled();
  });

  it("Esc closes", () => {
    const { popup, ta } = setup();
    ta.value = "/c";
    ta.selectionStart = ta.selectionEnd = 2;
    popup.handleInput();
    const e = new KeyboardEvent("keydown", { key: "Escape" });
    expect(popup.handleKey(e)).toBe(true);
    expect(popup.isOpen()).toBe(false);
  });

  it("ArrowDown advances selection", () => {
    const { popup, ta, provider } = setup();
    ta.value = "/c";
    ta.selectionStart = ta.selectionEnd = 2;
    popup.handleInput();
    const e = new KeyboardEvent("keydown", { key: "ArrowDown" });
    expect(popup.handleKey(e)).toBe(true);
    const pick = new KeyboardEvent("keydown", { key: "Enter" });
    popup.handleKey(pick);
    expect(provider.onPick).toHaveBeenCalled();
    const [picked] = provider.onPick.mock.calls[0];
    expect(picked).toBe("caveman");
  });
});
