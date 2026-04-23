// TODO(phase-4): src/electron-api-shim.js was deleted. The shape translation
// (tauri UsageSnapshot -> legacy { hour, session_pct, weekly_pct, ... } shape)
// no longer happens in a single testable JS function — src/shared/ipc.ts is a
// thin typed invoke() wrapper and the backend returns the renderer-ready shape
// directly (or views map fields inline). There's no unit-testable shim layer
// left to sandbox-eval, so the original assertions have no direct analogue.

import { describe, it } from "vitest";

describe.skip("getUsageHistory shape translation", () => {
  it("maps UsageSnapshot fields to the legacy renderer shape", () => {});
  it("filters out malformed snapshots instead of propagating undefined fields", () => {});
  it("handles empty backend history", () => {});
});
