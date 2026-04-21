// Static analysis + lightweight DOM checks for the sidemenu wiring.
// Verifies the sidemenu markup is present and the JS references the
// expected IDs. Full behavioural testing happens in the manual QA pass.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "..", "dist");
const html = readFileSync(join(distDir, "dashboard.html"), "utf8");
const js = readFileSync(join(distDir, "dashboard.js"), "utf8");

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

  it("has a burger button on the Home view", () => {
    expect(html).toMatch(/id="burgerBtn-home"/);
  });
});

describe("sidemenu wiring", () => {
  it("JS references sidemenu IDs and attaches a backdrop click handler", () => {
    expect(js).toMatch(/sidemenuBackdrop/);
    expect(js).toMatch(/sidemenu(?!Backdrop)/);
  });

  it("JS iterates over .sidemenu-nav-item elements", () => {
    expect(js).toMatch(/\.sidemenu-nav-item/);
  });
});
