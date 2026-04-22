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

  it("includes a sort-by dropdown with expected options", () => {
    expect(html).toMatch(/id="projectsSortSelect"/);
    expect(html).toMatch(/value="recent"/);
    expect(html).toMatch(/value="live"/);
    expect(html).toMatch(/value="name"/);
    expect(html).toMatch(/value="tokens"/);
  });

  it("has an empty-state element", () => {
    expect(html).toMatch(/id="projects-empty"/);
  });

  it("has project-detail menu button + popover container", () => {
    expect(html).toMatch(/id="projectDetailMenuBtn"/);
    expect(html).toMatch(/id="projectDetailMenu"[^>]*class="menu-popover/);
    expect(html).toMatch(/data-menu-item="notif-overrides"/);
    expect(html).toMatch(/data-menu-item="automation"/);
    expect(html).toMatch(/data-menu-item="folder-mapping"/);
  });

  it("has subviews for overrides / automation / folder-mapping / sessions / session-detail", () => {
    expect(html).toMatch(/id="view-project-notif-overrides"/);
    expect(html).toMatch(/id="view-project-automation"/);
    expect(html).toMatch(/id="view-project-folder-mapping"/);
    expect(html).toMatch(/id="view-project-sessions"/);
    expect(html).toMatch(/id="view-session-detail"/);
  });

  it("each project subview has a back button", () => {
    expect(html).toMatch(/id="notifOverridesBackBtn"/);
    expect(html).toMatch(/id="automationBackBtn"/);
    expect(html).toMatch(/id="folderMappingBackBtn"/);
    expect(html).toMatch(/id="allSessionsBackBtn"/);
    expect(html).toMatch(/id="sessionDetailBackBtn"/);
  });
});
