// Rewired from the deleted src/modules/sound-packs.js — imports directly from
// src/shared/sound-packs.ts. We stub window + the Tauri runtime globals before
// the module registers itself.

import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";

// The module reads window at import time (attaches SoundPacks global). We must
// stub window/document BEFORE importing. A single global JSDOM is fine; each
// test replaces window.__TAURI__ and calls invalidateCache() to reset.
const bootstrapDom = new JSDOM(`<!DOCTYPE html>`);
globalThis.window = bootstrapDom.window;
globalThis.document = bootstrapDom.window.document;

const SP = await import("../src/shared/sound-packs.ts");

function stubTauri(commands) {
  return {
    core: {
      invoke: async (cmd, _args) => {
        const handler = commands[cmd];
        if (!handler) throw new Error(`unstubbed invoke: ${cmd}`);
        return handler();
      },
    },
  };
}

describe("two-step picker populates from pack catalog", () => {
  let dom;

  beforeEach(() => {
    dom = new JSDOM(`
      <select id="pack"></select>
      <select id="sound"></select>
    `);
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    dom.window.__TAURI__ = stubTauri({
      list_sound_packs: () => ([
        { id: "default", label: "Default", installed: true,
          sounds: [{ id: "s1.mp3", label: "S1" }] },
        { id: "peon", label: "Peon", installed: false,
          sounds: [{ id: "work.mp3", label: "Work work" }] },
      ]),
    });
    SP.invalidateCache();
  });

  it("exposes the expected API", () => {
    for (const fn of ["loadPacks", "findPack", "populatePackSelect", "populateSoundSelect", "installPack"]) {
      expect(typeof SP[fn]).toBe("function");
    }
  });

  it("populatePackSelect shows installed/not-installed label", async () => {
    const packs = await SP.loadPacks();
    const packEl = dom.window.document.getElementById("pack");
    SP.populatePackSelect(packEl, packs, "default");
    expect(packEl.innerHTML).toContain(">Default<");
    expect(packEl.innerHTML).toContain("Peon (not installed)");
    expect(packEl.value).toBe("default");
  });

  it("changing pack swaps sound options", async () => {
    const packs = await SP.loadPacks();
    const packEl = dom.window.document.getElementById("pack");
    const soundEl = dom.window.document.getElementById("sound");

    SP.populatePackSelect(packEl, packs, "default");
    SP.populateSoundSelect(soundEl, SP.findPack(packs, "default"), "s1.mp3");
    expect(soundEl.value).toBe("s1.mp3");
    expect(soundEl.innerHTML).toContain("S1");

    // Simulate user switching to peon
    packEl.value = "peon";
    SP.populateSoundSelect(soundEl, SP.findPack(packs, packEl.value), null);
    expect(soundEl.innerHTML).toContain("Work work");
    expect(soundEl.innerHTML).not.toContain(">S1<");
  });
});
