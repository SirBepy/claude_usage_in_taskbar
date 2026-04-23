import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const moduleSrc = fs.readFileSync(
  path.resolve(__dirname, "../src/modules/sound-packs.js"),
  "utf8",
);

function loadModuleIntoDom(dom) {
  // Inject the IIFE as a <script> tag so JSDOM runs it in its own window
  // context, giving the IIFE access to the JSDOM window global.
  const s = dom.window.document.createElement("script");
  s.textContent = moduleSrc;
  dom.window.document.body.appendChild(s);
}

describe("two-step picker populates from pack catalog", () => {
  let dom;
  beforeEach(() => {
    dom = new JSDOM(`
      <select id="pack"></select>
      <select id="sound"></select>
    `, { runScripts: "dangerously" });
    // Stub electronAPI before loading module
    dom.window.electronAPI = {
      listSoundPacks: async () => ([
        { id: "default", label: "Default", installed: true,
          sounds: [{ id: "s1.mp3", label: "S1" }] },
        { id: "peon", label: "Peon", installed: false,
          sounds: [{ id: "work.mp3", label: "Work work" }] },
      ]),
    };
    loadModuleIntoDom(dom);
  });

  it("exposes window.SoundPacks with the expected API", () => {
    const SP = dom.window.SoundPacks;
    expect(SP).toBeDefined();
    for (const fn of ["loadPacks", "findPack", "populatePackSelect", "populateSoundSelect", "installPack"]) {
      expect(typeof SP[fn]).toBe("function");
    }
  });

  it("populatePackSelect shows installed/not-installed label", async () => {
    const SP = dom.window.SoundPacks;
    const packs = await SP.loadPacks();
    const packEl = dom.window.document.getElementById("pack");
    SP.populatePackSelect(packEl, packs, "default");
    expect(packEl.innerHTML).toContain(">Default<");
    expect(packEl.innerHTML).toContain("Peon (not installed)");
    expect(packEl.value).toBe("default");
  });

  it("changing pack swaps sound options", async () => {
    const SP = dom.window.SoundPacks;
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
