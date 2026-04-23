// Static analysis + lightweight DOM checks for the sidemenu wiring.
// Rewired from the deleted src/dashboard.js to read from src/main.ts and
// src/shared/sidemenu.ts where the logic now lives.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "..", "src");
const html = readFileSync(join(distDir, "index.html"), "utf8");
const mainTs = readFileSync(join(distDir, "main.ts"), "utf8");
const sidemenuTs = readFileSync(join(distDir, "shared", "sidemenu.ts"), "utf8");
const combinedJs = `${mainTs}\n${sidemenuTs}`;

describe("sidemenu markup", () => {
  it("includes a backdrop and an aside element", () => {
    expect(html).toMatch(/id="sidemenuBackdrop"/);
    expect(html).toMatch(/<aside[^>]*id="sidemenu"/);
  });

  it("has all four top-level nav items with data-view attributes", () => {
    for (const view of ["dashboard", "statistics", "projects", "settings"]) {
      expect(html).toMatch(new RegExp(`data-view="${view}"`));
    }
  });

  it("home view template declares a burger button", () => {
    // Home view migrated to src/views/dashboard; burger lives in the lit-html
    // template there rather than in index.html.
    const dashTs = readFileSync(
      join(distDir, "views", "dashboard", "dashboard.ts"),
      "utf8",
    );
    expect(dashTs).toMatch(/class="icon-btn burger"/);
    expect(dashTs).toMatch(/data-burger="true"/);
  });
});

describe("sidemenu wiring", () => {
  it("TS references sidemenu IDs and attaches a backdrop click handler", () => {
    expect(combinedJs).toMatch(/sidemenuBackdrop/);
    expect(combinedJs).toMatch(/sidemenu(?!Backdrop)/);
  });

  it("TS iterates over .sidemenu-nav-item elements", () => {
    expect(combinedJs).toMatch(/\.sidemenu-nav-item/);
  });
});
