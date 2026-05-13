# Dedupe effort-presets logic between modal and settings subview

## Goal
Extract the shared `MODELS`, `EFFORTS`, `DEFAULT_PRESETS`, and `readPresets()` definitions into one TS module so the New Session modal and the Settings → Session presets subview consume the same source.

## Context
Two files independently define the same constants and reader:
- `src/views/sessions/model-effort-modal.ts` lines ~14-41 (`MODELS`, `EFFORTS`, `DEFAULT_PRESETS`, `readPresets`, `readLastChoice`)
- `src/views/settings/subviews/presets/presets.ts` lines ~20-54 (`MODELS`, `EFFORTS`, `DEFAULT_PRESETS`, `readPresets`, `isModel`, `isEffort`)

Both `readPresets` implementations have minor differences — modal returns `DEFAULT_PRESETS` when count is not exactly 3, settings pads missing rows with defaults — but the validation rules and the constant arrays are identical. A change to a preset name or model option must be made twice today.

## Approach
1. Create `src/shared/effort-presets.ts` exporting:
   - `MODELS` (readonly tuple)
   - `EFFORTS` (readonly tuple)
   - `DEFAULT_PRESETS` (typed `Preset[]`)
   - `Preset` / `SessionConfig` interfaces
   - `isModel(v): v is typeof MODELS[number]`
   - `isEffort(v): v is typeof EFFORTS[number]`
   - `readPresets(settings, opts?: { padWithDefaults?: boolean }): Preset[]` — opts flag covers the two existing behaviors.
   - `readLastChoice(settings, projectPath): SessionConfig | null`
2. Replace the duplicate blocks in `model-effort-modal.ts` and `presets.ts` with imports from the new module.
3. Run `npx tsc --noEmit`; verify both views still compile.

## Acceptance
- `MODELS`/`EFFORTS`/`DEFAULT_PRESETS`/`readPresets` appear in exactly one TS file under `src/shared/`.
- Both consumers import from there.
- `npx tsc --noEmit` clean.
