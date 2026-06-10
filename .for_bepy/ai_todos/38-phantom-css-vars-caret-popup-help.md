# Replace phantom CSS vars in caret-popup and help builtin

## Goal

`src/shared/chat/caret-popup/popup.css:9` and `src/shared/chat/builtins/help.css:12,24` still reference `--color-border-1`, a variable that does not exist anywhere, so they silently render their hardcoded `#333` fallback and ignore the active theme.

## Context

The 2026-06-10 changes-panel retheme (commit 5c9f4a3) fixed the same disease in sessions.css: the `--color-background-elev-*` / `--color-border-1` / `--color-text-2/3` family was never defined; real kit tokens live in `vendor/tauri_kit/frontend/settings/styles/tokens.css` (`--color-background`, `--color-surface`, `--color-surface-alt`, `--color-border`, `--color-text`, `--color-text-muted`, `--color-primary`, `--color-danger`). These two files were out of scope then. See memory `diff-enhancer-architecture` for the token list.

## Approach

Replace `var(--color-border-1, #333)` with `var(--color-border)` in both files. While there, scan each file for any other `--color-*` name not in the kit token list and map it to the nearest real token. Verify with a grep that `--color-border-1|--color-background-elev|--color-text-[23]` has zero hits left under `src/`.

## Acceptance

- `grep -r "color-border-1\|background-elev\|color-text-2\|color-text-3" src/` returns nothing.
- Caret popup and /help card borders visibly follow the palette (check one dark + one light theme).
