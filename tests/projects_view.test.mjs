// Light static-analysis + DOM rendering test for the Projects view.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "..", "dist");
const html = readFileSync(join(distDir, "dashboard.html"), "utf8");

describe("Projects view DOM", () => {
  it("has a projects-list container inside view-projects", () => {
    expect(html).toMatch(/id="projects-list"/);
  });

  it("includes a grid/list toggle with mode buttons", () => {
    expect(html).toMatch(/id="projectsViewModeToggle"/);
    expect(html).toMatch(/data-mode="grid"/);
    expect(html).toMatch(/data-mode="list"/);
  });

  it("has an empty-state element", () => {
    expect(html).toMatch(/id="projects-empty"/);
  });
});
