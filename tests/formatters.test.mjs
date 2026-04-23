// Unit tests for pure helpers in src/shared/formatters.ts + src/shared/time.ts.
// Rewired from the deleted src/modules/formatters.js — vitest imports TS directly.

import { describe, it, expect } from "vitest";
import { pctColor, getThresholdColor, getPaceColor, fmtPct } from "../src/shared/formatters.ts";
import { hourToMs } from "../src/shared/time.ts";

describe("pctColor", () => {
  it("returns dim for null/undefined", () => {
    expect(pctColor(null)).toBe("var(--text-dim)");
    expect(pctColor(undefined)).toBe("var(--text-dim)");
  });
  it("green below 50", () => {
    expect(pctColor(0)).toBe("#27ae60");
    expect(pctColor(49)).toBe("#27ae60");
  });
  it("orange at 50-79", () => {
    expect(pctColor(50)).toBe("#e67e22");
    expect(pctColor(79)).toBe("#e67e22");
  });
  it("red at 80+", () => {
    expect(pctColor(80)).toBe("#e74c3c");
    expect(pctColor(100)).toBe("#e74c3c");
  });
});

describe("fmtPct", () => {
  it("appends % for real numbers", () => {
    expect(fmtPct(0)).toBe("0%");
    expect(fmtPct(42)).toBe("42%");
  });
  it("renders -- for null/undefined", () => {
    expect(fmtPct(null)).toBe("--");
    expect(fmtPct(undefined)).toBe("--");
  });
});

describe("getThresholdColor", () => {
  const thresholds = [
    { min: 0, color: "green" },
    { min: 50, color: "orange" },
    { min: 80, color: "red" },
  ];
  it("picks highest matching threshold", () => {
    expect(getThresholdColor(10, thresholds)).toBe("green");
    expect(getThresholdColor(55, thresholds)).toBe("orange");
    expect(getThresholdColor(95, thresholds)).toBe("red");
  });
  it("returns null when inputs empty", () => {
    expect(getThresholdColor(null, thresholds)).toBeNull();
    expect(getThresholdColor(50, [])).toBeNull();
    expect(getThresholdColor(50, null)).toBeNull();
  });
});

describe("getPaceColor", () => {
  // With paceBand 10 and safePace 50:
  //   pct <  40  → under
  //   40 <= pct <  50  → nearSafe
  //   50 <= pct <  60  → nearOver
  //   pct >= 60  → over
  const settings = {
    paceBand: 10,
    paceColors: { under: "U", nearSafe: "NS", nearOver: "NO", over: "O" },
  };
  it("classifies each band", () => {
    expect(getPaceColor(30, 50, settings)).toBe("U");
    expect(getPaceColor(45, 50, settings)).toBe("NS");
    expect(getPaceColor(55, 50, settings)).toBe("NO");
    expect(getPaceColor(70, 50, settings)).toBe("O");
  });
  it("defaults band to 10 and colors to built-ins when unset", () => {
    const c = getPaceColor(30, 50, {});
    expect(c).toBe("#27ae60");
  });
});

describe("hourToMs", () => {
  it("parses YYYY-MM-DDTHH as local time", () => {
    const ms = hourToMs("2026-04-19T14");
    const d = new Date(ms);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(3); // April
    expect(d.getDate()).toBe(19);
    expect(d.getHours()).toBe(14);
    expect(d.getMinutes()).toBe(0);
  });
  it("parses YYYY-MM-DDTHH:MM as local time", () => {
    const ms = hourToMs("2026-04-19T14:30");
    const d = new Date(ms);
    expect(d.getHours()).toBe(14);
    expect(d.getMinutes()).toBe(30);
  });
});
