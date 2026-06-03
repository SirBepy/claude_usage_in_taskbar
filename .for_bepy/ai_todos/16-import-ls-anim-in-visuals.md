# Import LS_ANIM constant in visuals.ts instead of hardcoding

## Goal
Remove the raw string `"cc_sidebar_animations"` from visuals.ts and import the `LS_ANIM` constant exported by sidebar-anim.ts.

## Context
`sidebar-anim.ts:1` exports `export const LS_ANIM = "cc_sidebar_animations"` precisely so consumers don't hardcode the key. However `visuals.ts:188` and `visuals.ts:191` both use the raw string literal `"cc_sidebar_animations"` directly when reading/writing the sidebar-animations toggle in Settings > Visuals.

## Approach
1. Add `import { LS_ANIM } from "../../../sessions/sidebar-anim";` to `src/views/settings/subviews/visuals/visuals.ts`.
2. Replace both occurrences of `"cc_sidebar_animations"` in visuals.ts with `LS_ANIM`.
3. Verify `cargo build` still passes (no Rust changes needed).

## Acceptance
- `grep -c '"cc_sidebar_animations"' src/views/settings/subviews/visuals/visuals.ts` returns 0.
- The Settings > Visuals sidebar-animations toggle still reads and writes correctly.
