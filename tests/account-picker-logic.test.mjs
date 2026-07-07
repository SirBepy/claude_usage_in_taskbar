import { describe, it, expect } from "vitest";
import {
  resolveInitialAccountId,
  shouldOfferRemember,
} from "../src/views/sessions/account-picker-logic.ts";

const personal = { id: "acct-personal", label: "Personal", icon: "user", colour: "#9d7dfc" };
const work = { id: "acct-work", label: "Work", icon: "briefcase", colour: "#f5a623" };
const fibo = { id: "acct-fibo", label: "Fibo", icon: "palette", colour: "#3ecf8e" };

describe("resolveInitialAccountId", () => {
  it("returns null when the registry is empty", () => {
    expect(resolveInitialAccountId(null, null, [])).toBeNull();
    expect(resolveInitialAccountId("acct-work", "acct-work", [])).toBeNull();
  });

  it("prefers the project's bound account over the default", () => {
    expect(resolveInitialAccountId("acct-work", "acct-personal", [personal, work, fibo])).toBe(
      "acct-work",
    );
  });

  it("falls back to the default account when there is no binding", () => {
    expect(resolveInitialAccountId(null, "acct-fibo", [personal, work, fibo])).toBe("acct-fibo");
  });

  it("ignores a binding that points at a removed account", () => {
    expect(resolveInitialAccountId("acct-deleted", "acct-work", [personal, work])).toBe(
      "acct-work",
    );
  });

  it("ignores a default that points at a removed account, falling back further", () => {
    // No binding, default is stale, but exactly one account remains.
    expect(resolveInitialAccountId(null, "acct-deleted", [personal])).toBe("acct-personal");
  });

  it("falls back to the sole account when neither binding nor default is set", () => {
    expect(resolveInitialAccountId(null, null, [work])).toBe("acct-work");
  });

  it("returns null when nothing resolves and multiple accounts exist", () => {
    expect(resolveInitialAccountId(null, null, [personal, work])).toBeNull();
    expect(resolveInitialAccountId("acct-deleted", "acct-also-deleted", [personal, work])).toBeNull();
  });
});

describe("shouldOfferRemember", () => {
  it("is false when nothing is chosen yet", () => {
    expect(shouldOfferRemember(null, null)).toBe(false);
    expect(shouldOfferRemember(null, "acct-personal")).toBe(false);
  });

  it("is false when the chosen account matches the resolved one", () => {
    expect(shouldOfferRemember("acct-personal", "acct-personal")).toBe(false);
  });

  it("is true when the user picks something other than the resolved account", () => {
    expect(shouldOfferRemember("acct-work", "acct-personal")).toBe(true);
  });

  it("is true when the user picks anything and nothing had resolved before", () => {
    expect(shouldOfferRemember("acct-work", null)).toBe(true);
  });
});
