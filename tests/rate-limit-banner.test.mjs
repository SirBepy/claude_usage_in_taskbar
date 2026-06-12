// Tests for the global rate-limit banner controller: it activates only on
// "rejected" rate-limit events, tracks every interrupted session, runs a
// countdown, and on reset sends "continue" to each interrupted chat when
// auto-continue is on (and to none when it's off).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";

const { RateLimitBanner } = await import("../src/shared/chat/rate-limit-banner.ts");

let host;
beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body><div id='host'></div></body></html>");
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  host = dom.window.document.getElementById("host");
});

function rejected({ resetsAt = 1000, rateLimitType = "five_hour" } = {}) {
  return JSON.stringify({ status: "rejected", rateLimitType, resetsAt });
}

describe("RateLimitBanner", () => {
  it("ignores non-rejected payloads", () => {
    const b = new RateLimitBanner();
    b.mount(host);
    b.report("s1", JSON.stringify({ status: "allowed_warning", rateLimitType: "five_hour", resetsAt: 1000 }));
    expect(b.state.active).toBe(false);
    expect(host.hidden).toBe(true);
  });

  it("activates on a rejection and names the limit + reset time", () => {
    let nowMs = 100 * 1000; // well before reset
    const b = new RateLimitBanner({ now: () => nowMs });
    b.mount(host);
    b.report("s1", rejected({ resetsAt: 1000, rateLimitType: "five_hour" }));

    expect(b.state.active).toBe(true);
    expect(b.state.interrupted).toEqual(["s1"]);
    expect(host.hidden).toBe(false);
    expect(host.querySelector(".rlb-title").textContent).toBe("5-hour limit reached");
    expect(host.querySelector(".rlb-countdown").textContent).toMatch(/remaining/);
  });

  it("maps weekly rateLimitType label", () => {
    const b = new RateLimitBanner({ now: () => 0 });
    b.mount(host);
    b.report("s1", rejected({ rateLimitType: "seven_day" }));
    expect(host.querySelector(".rlb-title").textContent).toBe("Weekly limit reached");
  });

  it("tracks multiple interrupted sessions under one banner", () => {
    const b = new RateLimitBanner({ now: () => 0 });
    b.mount(host);
    b.report("s1", rejected());
    b.report("s2", rejected());
    b.report("s1", rejected()); // dup session -> still one entry
    expect(b.state.interrupted.sort()).toEqual(["s1", "s2"]);
  });

  it("on reset with auto-continue ON, sends 'continue' to every interrupted session", () => {
    let nowMs = 100 * 1000;
    const sent = [];
    const b = new RateLimitBanner({ now: () => nowMs, sendContinue: (id) => sent.push(id) });
    b.mount(host);
    b.report("s1", rejected({ resetsAt: 1000 }));
    b.report("s2", rejected({ resetsAt: 1000 }));

    // Before reset: nothing fires, banner stays.
    nowMs = 999 * 1000;
    b.tick();
    expect(sent).toEqual([]);
    expect(b.state.active).toBe(true);

    // At/after reset: continue fires for each, banner clears.
    nowMs = 1000 * 1000;
    b.tick();
    expect(sent.sort()).toEqual(["s1", "s2"]);
    expect(b.state.active).toBe(false);
    expect(host.hidden).toBe(true);
  });

  it("on reset with auto-continue OFF, sends nothing and just clears", () => {
    let nowMs = 100 * 1000;
    const sent = [];
    const b = new RateLimitBanner({ now: () => nowMs, sendContinue: (id) => sent.push(id) });
    b.mount(host);
    b.report("s1", rejected({ resetsAt: 1000 }));

    // Uncheck the auto-continue box.
    const cb = host.querySelector(".rlb-auto-cb");
    cb.checked = false;
    cb.dispatchEvent(new globalThis.document.defaultView.Event("change"));
    expect(b.state.autoContinue).toBe(false);

    nowMs = 1000 * 1000;
    b.tick();
    expect(sent).toEqual([]);
    expect(b.state.active).toBe(false);
  });
});
