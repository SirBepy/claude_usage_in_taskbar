// Light static-analysis + DOM rendering test for the Projects view.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "..", "src");
const html = readFileSync(join(distDir, "index.html"), "utf8");
const projectsTs = readFileSync(
  join(distDir, "views", "projects", "projects.ts"),
  "utf8",
);
const projectDetailTs = readFileSync(
  join(distDir, "views", "project-detail", "project-detail.ts"),
  "utf8",
);
const characterPickTs = readFileSync(
  join(distDir, "views", "project-detail", "subviews", "character-pick", "character-pick.ts"),
  "utf8",
);
const automationTs = readFileSync(
  join(distDir, "views", "project-detail", "subviews", "automation", "automation.ts"),
  "utf8",
);
const folderMappingTs = readFileSync(
  join(distDir, "views", "project-detail", "subviews", "folder-mapping", "folder-mapping.ts"),
  "utf8",
);
const sessionsListTs = readFileSync(
  join(distDir, "views", "project-detail", "subviews", "sessions-list", "sessions-list.ts"),
  "utf8",
);
const sessionDetailTs = readFileSync(
  join(distDir, "views", "session-detail", "session-detail.ts"),
  "utf8",
);
const subviewHeaderTs = readFileSync(
  join(distDir, "views", "project-detail", "subview-header.ts"),
  "utf8",
);

describe("Projects view DOM", () => {
  it("has a projects-list container in the migrated view", () => {
    expect(projectsTs).toMatch(/id="projects-list"/);
  });

  it("includes a sort-by dropdown with expected options", () => {
    expect(projectsTs).toMatch(/id="projectsSortSelect"/);
    expect(projectsTs).toMatch(/value="recent"/);
    expect(projectsTs).toMatch(/value="name"/);
  });

  it("has an empty-state element", () => {
    expect(projectsTs).toMatch(/id="projects-empty"/);
  });

  it("has project-detail menu button + popover container", () => {
    expect(projectDetailTs).toMatch(/id="projectDetailMenuBtn"/);
    expect(projectDetailTs).toMatch(/id="projectDetailMenu"[^>]*class="menu-popover/);
    expect(projectDetailTs).toMatch(/data-menu-item="character-pick"/);
    expect(projectDetailTs).toMatch(/data-menu-item="automation"/);
    expect(projectDetailTs).toMatch(/data-menu-item="folder-mapping"/);
  });

  it("has subviews for character-pick / automation / folder-mapping / sessions / session-detail", () => {
    expect(characterPickTs).toMatch(/view-project-character-pick/);
    expect(automationTs).toMatch(/view-project-automation/);
    expect(folderMappingTs).toMatch(/view-project-folder-mapping/);
    expect(sessionsListTs).toMatch(/view-project-sessions/);
    expect(sessionDetailTs).toMatch(/view-session-detail/);
  });

  it("each project subview has a back button", () => {
    // character-pick still owns its own back button
    expect(characterPickTs).toMatch(/id="characterPickBackBtn"/);
    // remaining subviews delegate to the shared subview-header component
    expect(subviewHeaderTs).toMatch(/ph-arrow-left/);
    expect(subviewHeaderTs).toMatch(/icon-btn/);
    expect(automationTs).toMatch(/subview-header/);
    expect(folderMappingTs).toMatch(/subview-header/);
    expect(sessionsListTs).toMatch(/subview-header/);
    expect(sessionDetailTs).toMatch(/subview-header/);
  });

  it("automation + character-pick + path-editor DOM moved out of project-detail view", () => {
    expect(projectDetailTs).not.toMatch(/id="automationSection"/);
    expect(projectDetailTs).not.toMatch(/id="projectNotifOverridesSection"/);
    expect(projectDetailTs).not.toMatch(/id="projectDetailPath"[^A-Za-z]/);
    expect(projectDetailTs).not.toMatch(/id="projectDetailPathInput"/);
    expect(projectDetailTs).not.toMatch(/id="project-merged-paths"/);
    expect(projectDetailTs).not.toMatch(/id="hideProjectBtn"/);
  });

  it("automation subview contains the form fields", () => {
    expect(automationTs).toMatch(/id="automationEnabled"/);
    expect(automationTs).toMatch(/id="automateChannelBtn"/);
  });

  it("folder-mapping subview contains path editor + merged + hide", () => {
    expect(folderMappingTs).toMatch(/id="projectDetailPath"/);
    expect(folderMappingTs).toMatch(/id="project-merged-paths"/);
    expect(folderMappingTs).toMatch(/id="hideProjectBtn"/);
  });

  it("character-pick subview owns the dropdown", () => {
    expect(characterPickTs).toMatch(/id="character-select"/);
  });
});
