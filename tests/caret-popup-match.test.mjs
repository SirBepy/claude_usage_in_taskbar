import { describe, it, expect } from "vitest";
import { match } from "../src/shared/chat/caret-popup/match.ts";

const E = (name, source = "user-skill") => ({
  name,
  args: null,
  description: "",
  source: { kind: source },
});

describe("caret-popup match", () => {
  it("returns input as-is (capped) when query is empty", () => {
    const items = ["a", "b", "c"].map((n) => E(n));
    expect(match(items, "")).toHaveLength(3);
  });

  it("prefix match outranks fuzzy subsequence", () => {
    const items = [E("compact-output"), E("commit")];
    const out = match(items, "comm");
    expect(out[0].name).toBe("commit");
  });

  it("fuzzy subsequence finds lsc -> local-session-chat", () => {
    const items = ["caveman", "local-session-chat", "loop"].map((n) => E(n));
    const out = match(items, "lsc");
    expect(out.map((e) => e.name)).toContain("local-session-chat");
  });

  it("returns empty when nothing matches", () => {
    const items = [E("alpha"), E("beta")];
    expect(match(items, "xyz")).toHaveLength(0);
  });

  it("source priority breaks ties (project-command beats user-skill)", () => {
    const items = [E("commit", "user-skill"), E("commit", "project-command")];
    const out = match(items, "commit");
    expect(out[0].source.kind).toBe("project-command");
  });

  it("caps results at 50", () => {
    const items = Array.from({ length: 200 }, (_, i) => E(`item${i}`));
    expect(match(items, "")).toHaveLength(50);
  });
});
