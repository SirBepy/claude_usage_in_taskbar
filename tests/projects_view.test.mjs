// Light static-analysis + DOM rendering test for the Projects view.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "..", "src");
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

  it("automation + notif-override + path-editor DOM moved out of #view-project-detail", () => {
    const detailMatch = html.match(/<div id="view-project-detail"[\s\S]*?<!-- /);
    expect(detailMatch, "could not locate detail view block").toBeTruthy();
    const detailBlock = detailMatch[0];
    expect(detailBlock).not.toMatch(/id="automationSection"/);
    expect(detailBlock).not.toMatch(/id="projectNotifOverridesSection"/);
    expect(detailBlock).not.toMatch(/id="projectDetailPath"/);
    expect(detailBlock).not.toMatch(/id="projectDetailPathInput"/);
    expect(detailBlock).not.toMatch(/id="project-merged-paths"/);
    expect(detailBlock).not.toMatch(/id="hideProjectBtn"/);
  });

  it("automation subview contains the form fields", () => {
    expect(html).toMatch(/id="view-project-automation"[\s\S]*?id="automationEnabled"/);
    expect(html).toMatch(/id="view-project-automation"[\s\S]*?id="automateChannelBtn"/);
  });

  it("folder-mapping subview contains path editor + merged + hide", () => {
    expect(html).toMatch(/id="view-project-folder-mapping"[\s\S]*?id="projectDetailPath"/);
    expect(html).toMatch(/id="view-project-folder-mapping"[\s\S]*?id="project-merged-paths"/);
    expect(html).toMatch(/id="view-project-folder-mapping"[\s\S]*?id="hideProjectBtn"/);
  });

  it("notif-overrides subview owns the template + rows container", () => {
    expect(html).toMatch(/id="view-project-notif-overrides"[\s\S]*?id="projectOverrideRowTemplate"/);
    expect(html).toMatch(/id="view-project-notif-overrides"[\s\S]*?id="projectOverrideRows"/);
  });
});
