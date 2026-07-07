import { describe, it, expect } from "vitest";
import {
  ICON_POOL,
  COLOUR_POOL,
  LOGIN_TIMEOUT_MS,
  pickAvailableIcon,
  nextRerollIndex,
  prefillLabel,
  tierLabel,
  formatElapsed,
  isLoginTimedOut,
  describeLoginOutcome,
} from "../src/views/settings/subviews/accounts/wizard-logic.ts";

describe("pickAvailableIcon", () => {
  it("returns the first pool entry when nothing is used", () => {
    expect(pickAvailableIcon(ICON_POOL, [])).toBe(ICON_POOL[0]);
  });

  it("skips icons already used by other accounts", () => {
    const used = [ICON_POOL[0], ICON_POOL[1]];
    expect(pickAvailableIcon(ICON_POOL, used)).toBe(ICON_POOL[2]);
  });

  it("wraps around the pool from a non-zero startIndex", () => {
    const startIndex = ICON_POOL.length - 1;
    const used = [];
    expect(pickAvailableIcon(ICON_POOL, used, startIndex)).toBe(ICON_POOL[startIndex]);
  });

  it("falls back to the startIndex entry when every icon is taken", () => {
    expect(pickAvailableIcon(ICON_POOL, [...ICON_POOL], 3)).toBe(ICON_POOL[3]);
  });

  it("returns empty string for an empty pool", () => {
    expect(pickAvailableIcon([], [])).toBe("");
  });
});

describe("nextRerollIndex", () => {
  it("advances by one and wraps at the end of the pool", () => {
    expect(nextRerollIndex(ICON_POOL, 0)).toBe(1);
    expect(nextRerollIndex(ICON_POOL, ICON_POOL.length - 1)).toBe(0);
  });

  it("returns 0 for an empty pool", () => {
    expect(nextRerollIndex([], 5)).toBe(0);
  });
});

describe("reroll skip-used integration", () => {
  it("repeated rerolls never land on an icon another account already uses", () => {
    const used = new Set([ICON_POOL[0], ICON_POOL[2], ICON_POOL[4]]);
    let index = 0;
    let icon = pickAvailableIcon(ICON_POOL, used, index);
    for (let i = 0; i < ICON_POOL.length * 2; i++) {
      expect(used.has(icon)).toBe(false);
      index = nextRerollIndex(ICON_POOL, index);
      icon = pickAvailableIcon(ICON_POOL, used, index);
    }
  });
});

describe("prefillLabel", () => {
  it("prefers the organization name when present", () => {
    expect(
      prefillLabel({ organizationName: "Fibo Studio", emailAddress: "joe@fibo.hr" }),
    ).toBe("Fibo Studio");
  });

  it("falls back to a title-cased email local part when org name is absent", () => {
    expect(prefillLabel({ organizationName: null, emailAddress: "joe.muzic@example.com" })).toBe(
      "Joe Muzic",
    );
  });

  it("falls back to the raw email when the local part yields nothing usable", () => {
    expect(prefillLabel({ organizationName: "", emailAddress: "@example.com" })).toBe(
      "@example.com",
    );
  });

  it("ignores a whitespace-only organization name", () => {
    expect(prefillLabel({ organizationName: "   ", emailAddress: "a_b-c@x.com" })).toBe("A B C");
  });
});

describe("tierLabel", () => {
  it("maps known tiers to friendly labels", () => {
    expect(tierLabel("claude_max")).toBe("Max");
    expect(tierLabel("claude_pro")).toBe("Pro");
    expect(tierLabel("claude_team")).toBe("Team");
  });

  it("title-cases an unknown tier, stripping a claude_ prefix", () => {
    expect(tierLabel("claude_enterprise_plus")).toBe("Enterprise Plus");
  });

  it("falls back to a generic label when absent", () => {
    expect(tierLabel(null)).toBe("Unknown plan");
    expect(tierLabel(undefined)).toBe("Unknown plan");
    expect(tierLabel("")).toBe("Unknown plan");
  });
});

describe("formatElapsed", () => {
  it("formats sub-minute durations", () => {
    expect(formatElapsed(5000)).toBe("0:05");
  });

  it("formats minutes and seconds with zero-padding", () => {
    expect(formatElapsed(83000)).toBe("1:23");
  });

  it("clamps negative input to 0:00", () => {
    expect(formatElapsed(-500)).toBe("0:00");
  });
});

describe("isLoginTimedOut", () => {
  it("is false right up to the timeout", () => {
    expect(isLoginTimedOut(LOGIN_TIMEOUT_MS - 1)).toBe(false);
  });

  it("is true at and past the timeout", () => {
    expect(isLoginTimedOut(LOGIN_TIMEOUT_MS)).toBe(true);
    expect(isLoginTimedOut(LOGIN_TIMEOUT_MS + 1000)).toBe(true);
  });
});

describe("describeLoginOutcome", () => {
  it("maps Pending to kind pending", () => {
    expect(describeLoginOutcome({ status: "Pending" })).toEqual({ kind: "pending" });
  });

  it("maps Ready to kind ready, passing the identity through", () => {
    const identity = { emailAddress: "a@x.com", organizationUuid: "org-1" };
    expect(describeLoginOutcome({ status: "Ready", identity })).toEqual({
      kind: "ready",
      identity,
    });
  });

  it("maps Mismatch to a plain-English message naming both emails", () => {
    const result = describeLoginOutcome({
      status: "Mismatch",
      existing_email: "old@x.com",
      new_email: "new@x.com",
    });
    expect(result.kind).toBe("mismatch");
    expect(result.message).toContain("old@x.com");
    expect(result.message).toContain("new@x.com");
  });

  it("maps Duplicate to a message naming the existing label", () => {
    const result = describeLoginOutcome({ status: "Duplicate", existing_label: "Work" });
    expect(result.kind).toBe("duplicate");
    expect(result.message).toContain("Work");
  });
});

describe("pool sanity", () => {
  it("ICON_POOL and COLOUR_POOL are non-empty and de-duplicated", () => {
    expect(ICON_POOL.length).toBeGreaterThan(0);
    expect(new Set(ICON_POOL).size).toBe(ICON_POOL.length);
    expect(COLOUR_POOL.length).toBeGreaterThan(0);
    expect(new Set(COLOUR_POOL).size).toBe(COLOUR_POOL.length);
  });
});
