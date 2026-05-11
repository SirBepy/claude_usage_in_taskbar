import { describe, it, expect } from "vitest";
import { parseBuiltin, KNOWN_BUILTINS } from "../src/shared/chat/builtins/index.ts";

describe("parseBuiltin", () => {
  it("returns null for non-slash text", () => {
    expect(parseBuiltin("hello")).toBeNull();
    expect(parseBuiltin("")).toBeNull();
  });

  it("returns null for unknown slash", () => {
    expect(parseBuiltin("/notabuiltin")).toBeNull();
  });

  it("returns null for skill names (e.g. /commit)", () => {
    expect(parseBuiltin("/commit")).toBeNull();
  });

  it("matches /help", () => {
    expect(parseBuiltin("/help")?.name).toBe("help");
  });

  it("matches /clear with trailing args (captured but ignored)", () => {
    const r = parseBuiltin("/clear  some args");
    expect(r?.name).toBe("clear");
    expect(r?.args).toBe("some args");
  });

  it("matches each known builtin", () => {
    for (const n of KNOWN_BUILTINS) {
      expect(parseBuiltin(`/${n}`)?.name).toBe(n);
    }
  });

  it("does not match in the middle of text", () => {
    expect(parseBuiltin("hello /help world")).toBeNull();
  });
});
