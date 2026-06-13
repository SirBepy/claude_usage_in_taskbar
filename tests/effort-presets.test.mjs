import { describe, it, expect } from "vitest";
import {
  MODELS,
  readModels,
  readDefaultFlags,
  readPresets,
  readLastChoice,
  sortByImpressiveness,
} from "../src/shared/effort-presets.ts";

describe("readModels", () => {
  it("returns the default seed when settings.models is absent", () => {
    expect(readModels({})).toEqual([...MODELS]);
  });

  it("returns the default seed when settings.models is empty", () => {
    expect(readModels({ models: [] })).toEqual([...MODELS]);
  });

  it("returns the default seed when settings.models is not an array", () => {
    expect(readModels({ models: "haiku,sonnet" })).toEqual([...MODELS]);
  });

  it("returns the default seed when the array has no non-empty strings", () => {
    expect(readModels({ models: ["", "  ", 5, null] })).toEqual([...MODELS]);
  });

  it("returns a custom list, trimmed and deduped, order preserved", () => {
    expect(
      readModels({ models: [" opus ", "sonnet", "opus", "", "glm-4.6"] }),
    ).toEqual(["opus", "sonnet", "glm-4.6"]);
  });

  it("does not mutate the MODELS seed (returns a fresh array)", () => {
    const a = readModels({});
    a.push("extra");
    expect(readModels({})).toEqual([...MODELS]);
  });
});

describe("sortByImpressiveness", () => {
  it("orders families least-impressive-first (haiku, sonnet, opus, fable)", () => {
    const apiOrder = [
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
    ];
    expect(sortByImpressiveness(apiOrder)).toEqual([
      "claude-haiku-4-5-20251001",
      "claude-sonnet-4-6",
      "claude-opus-4-8",
      "claude-fable-5",
    ]);
  });

  it("pushes unknown families to the end, preserving their relative order", () => {
    expect(sortByImpressiveness(["glm-4.6", "claude-opus-4-8", "kimi-k2"])).toEqual([
      "claude-opus-4-8",
      "glm-4.6",
      "kimi-k2",
    ]);
  });
});

describe("readDefaultFlags", () => {
  it("defaults both flags to true when absent", () => {
    expect(readDefaultFlags({})).toEqual({ autoAccept: true, remote: true });
  });

  it("respects explicit false", () => {
    expect(
      readDefaultFlags({ defaultAutoAllow: false, defaultRemoteControl: false }),
    ).toEqual({ autoAccept: false, remote: false });
  });

  it("treats any non-false value as true", () => {
    expect(
      readDefaultFlags({ defaultAutoAllow: true, defaultRemoteControl: 0 }),
    ).toEqual({ autoAccept: true, remote: true });
  });

  it("flips flags independently", () => {
    expect(readDefaultFlags({ defaultAutoAllow: false })).toEqual({
      autoAccept: false,
      remote: true,
    });
  });
});

describe("readPresets loosened model validation", () => {
  it("accepts a user-defined model string not in MODELS", () => {
    const settings = {
      effortPresets: [
        { name: "Custom", model: "glm-4.6", effort: "high" },
        { name: "Normal", model: "opus", effort: "high" },
        { name: "Heavy", model: "opus", effort: "max" },
      ],
    };
    const out = readPresets(settings);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ name: "Custom", model: "glm-4.6", effort: "high" });
  });

  it("still rejects an invalid effort", () => {
    const settings = {
      effortPresets: [
        { name: "Bad", model: "glm-4.6", effort: "bogus" },
        { name: "Normal", model: "opus", effort: "high" },
        { name: "Heavy", model: "opus", effort: "max" },
      ],
    };
    // One invalid preset -> falls back to defaults (length-3 gate).
    const out = readPresets(settings);
    expect(out.find((p) => p.name === "Bad")).toBeUndefined();
  });
});

describe("readLastChoice loosened model validation", () => {
  it("accepts a user-defined model string", () => {
    const settings = {
      projectLastChoice: {
        "/proj": { model: "glm-4.6", effort: "high" },
      },
    };
    expect(readLastChoice(settings, "/proj")).toEqual({
      model: "glm-4.6",
      effort: "high",
    });
  });

  it("still rejects an invalid effort", () => {
    const settings = {
      projectLastChoice: {
        "/proj": { model: "glm-4.6", effort: "bogus" },
      },
    };
    expect(readLastChoice(settings, "/proj")).toBeNull();
  });
});
