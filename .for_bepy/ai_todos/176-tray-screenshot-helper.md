# Add a reusable Windows system-tray screenshot helper

**Type:** skill-improvement

## Goal
Give Claude a fast, reliable way to screenshot and zoom into the Windows system tray for this project, instead of hand-deriving screen coordinates via ad hoc PowerShell each time.

## Context
During the tray-icon-graphics-removal session (2026-07-08/09), verifying the new static icon + meeting dot required a manual loop: full-screen capture via `System.Windows.Forms.Screen`/`System.Drawing`, guess-crop a region near the tray, `Read` it, adjust coordinates, recrop, zoom with `InterpolationMode.NearestNeighbor`. It took 3 attempts to land on the actual tray icon (first crop caught the overflow chevron, second missed the icon entirely). This project (`claude_usage_in_taskbar`) puts a custom icon in the tray as its core UI surface, so this friction will recur on any future tray-icon visual work.

No existing skill or MCP tool (Playwright, claude-in-chrome, `/screenshot`) covers OS-level tray screenshotting — they're all web-content-scoped.

## Approach
Consider a small project-scoped skill or script (e.g. `.claude/skills/tray-screenshot` or a checked-in PowerShell script under `scripts/`) that:
1. Takes a full-screen screenshot.
2. Locates the taskbar tray region heuristically (bottom-right corner of the primary screen, above the clock) — could default to a configurable crop rect since taskbar icon positions drift as icons are added/removed/pinned.
3. Upscales with nearest-neighbor for pixel-level inspection (tray icons are 32x32, easy to lose detail at native res).
4. Optionally clicks a given tray icon by approximate index from the right (chevron, then icons right-to-left) so the same coordinates don't have to be rediscovered by hand each session.

## Acceptance
Next time a tray-icon visual change needs verification, Claude can capture + zoom the tray in one or two tool calls instead of 3+ guess-and-check iterations.
