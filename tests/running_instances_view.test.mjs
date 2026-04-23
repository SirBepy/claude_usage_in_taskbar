import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "..", "src");
const html = readFileSync(join(distDir, "index.html"), "utf8");
const js = readFileSync(join(distDir, "dashboard.js"), "utf8");

describe("running instances shell", () => {
  it("has runningInstancesList container", () => {
    expect(html).toMatch(/id="runningInstancesList"/);
    expect(html).toMatch(/id="runningInstancesEmpty"/);
    expect(html).toMatch(/id="runningInstancesCount"/);
  });

  it("JS subscribes to instances-changed", () => {
    expect(js).toMatch(/onInstancesChanged/);
  });

  it("JS renders instance rows with status dot and action buttons", () => {
    expect(js).toMatch(/renderRunningInstances/);
    expect(js).toMatch(/instance-row/);
    expect(js).toMatch(/phone-link-btn/);
  });
});
