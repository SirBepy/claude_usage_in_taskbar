import { describe, it, expect } from "vitest";
import {
  resolveDefaultDashboardAccountId,
  reconcileSelectedAccountId,
} from "../src/views/dashboard/account-selector-logic.ts";

const personal = { id: "acct-personal", label: "Personal", icon: "user", colour: "#9d7dfc" };
const work = { id: "acct-work", label: "Work", icon: "briefcase", colour: "#f5a623" };
const fibo = { id: "acct-fibo", label: "Fibo", icon: "palette", colour: "#3ecf8e" };

describe("resolveDefaultDashboardAccountId", () => {
  it("returns null for an empty registry", () => {
    expect(resolveDefaultDashboardAccountId("acct-work", [])).toBeNull();
    expect(resolveDefaultDashboardAccountId(null, [])).toBeNull();
  });

  it("prefers the global default account when it's registered", () => {
    expect(resolveDefaultDashboardAccountId("acct-work", [personal, work, fibo])).toBe("acct-work");
  });

  it("falls back to the first registered account when there's no default", () => {
    expect(resolveDefaultDashboardAccountId(null, [personal, work])).toBe("acct-personal");
  });

  it("falls back to the first account when the default points at a removed account", () => {
    expect(resolveDefaultDashboardAccountId("acct-deleted", [work, fibo])).toBe("acct-work");
  });
});

describe("reconcileSelectedAccountId", () => {
  it("keeps the current selection when it still exists", () => {
    expect(reconcileSelectedAccountId("acct-fibo", "acct-work", [personal, work, fibo])).toBe("acct-fibo");
  });

  it("re-resolves a default when the current selection was removed", () => {
    expect(reconcileSelectedAccountId("acct-deleted", "acct-work", [personal, work])).toBe("acct-work");
  });

  it("re-resolves to null when the registry became empty", () => {
    expect(reconcileSelectedAccountId("acct-personal", "acct-personal", [])).toBeNull();
  });

  it("resolves an initial selection from null the same way a fresh mount would", () => {
    expect(reconcileSelectedAccountId(null, null, [work, fibo])).toBe("acct-work");
  });
});
