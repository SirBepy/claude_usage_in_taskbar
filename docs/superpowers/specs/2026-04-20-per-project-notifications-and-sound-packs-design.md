# Per-project notification overrides + sound packs

**Date:** 2026-04-20
**Branch target:** `tauri-rewrite`
**Status:** Draft

## Goal

Let the user override notification config on a per-project basis, and introduce
downloadable "sound packs" so a project can play character-themed clips
(e.g. WC3 peon "Work work") instead of the default beeps.

## Non-goals

- User-uploaded custom sound packs
- Voice cloning / arbitrary TTS in character voice
- Pack versioning UI (manual app release bump is fine for v1)
- Migrating existing voice (Piper) flow

## Data model

Settings additions:

```js
notifications: { /* existing per-event defaults, unchanged */ },

soundPacks: {
  installed: ["peon", "peasant"]   // pack ids user has downloaded
},

projectNotifOverrides: {
  "<cwdKey>": {
    workFinished: {
      enabled: boolean,             // override toggle; false = inherit default
      mode: "sound" | "voice",
      soundPack: string,            // e.g. "peon" (only used when mode=sound)
      soundFile: string,            // e.g. "work-work.mp3"
      voiceName: string | null,     // only used when mode=voice
      template: string              // only used when mode=voice
    },
    questionAsked:    { /* same shape as workFinished */ },
    thresholdCrossed: { /* same shape as workFinished */ }
  }
}
```

`cwdKey` is the same normalised-path key already used by `projectAliases` and
`projectBlacklist`.

## Sound pack catalog

Static registry declared in a new module (frontend + mirror in Rust for
backend URL resolution):

```js
SOUND_PACKS = [
  { id: "default", label: "Default", bundled: true,
    sounds: [
      { id: "sound1.mp3", label: "Sound 1" },
      { id: "sound2.mp3", label: "Sound 2" },
      { id: "sound3.mp3", label: "Sound 3" },
      { id: "sound4.mp3", label: "Sound 4" },
      { id: "sound5.mp3", label: "Sound 5" },
      { id: "sound6.mp3", label: "Sound 6" }
    ]
  },

  { id: "peon", label: "Peon (Orc)", bundled: false,
    downloadUrl: "<github release>/sound-packs-v1/peon.zip",
    sounds: [
      { id: "work-work.mp3", label: "Work work" },
      { id: "ready.mp3",     label: "Ready to work" },
      { id: "yes.mp3",       label: "Yes?" },
      { id: "pissed.mp3",    label: "Me busy. Leave me alone!" },
      { id: "not-that-kind.mp3", label: "Me not that kind of orc!" },
      { id: "complete.mp3",  label: "Work complete" }
    ]
  },

  // peasant, acolyte, wisp follow the same shape as peon: bundled: false,
  // their own downloadUrl, and a curated ~5-8 sound list chosen from the
  // race's iconic worker lines. Final clip lists are in Open Items below.
  { id: "peasant", label: "Peasant (Human)",  bundled: false, downloadUrl: "...", sounds: [...] },
  { id: "acolyte", label: "Acolyte (Undead)", bundled: false, downloadUrl: "...", sounds: [...] },
  { id: "wisp",    label: "Wisp (Night Elf)", bundled: false, downloadUrl: "...", sounds: [...] }
];
```

Each non-default pack: ~5-8 curated clips, MP3 128 kbps, ~200 KB total per
pack. Hosted as GitHub release assets so packs ship independently of app
version.

## Delivery + storage

- **Bundled default sounds:** `tauri/assets/sounds/` (existing 6 files, no
  change)
- **Downloaded packs:** `<app-data>/sound-packs/<packId>/*.mp3`
  - New `paths::sound_packs_dir()` in `tauri/src/paths.rs`

New Rust module `tauri/src/soundpacks.rs` with Tauri commands:

| Command | Purpose |
|---|---|
| `list_sound_packs()` | Return catalog + per-pack installed flag |
| `install_sound_pack(id)` | Download zip from `downloadUrl`, unzip to `sound_packs_dir()/<id>/`. Idempotent (no-op if already installed) |
| `sound_pack_file_url(packId, soundId)` | Return a URL/path the `<audio>` tag can play (asset protocol for bundled; file path for downloaded) |

## Runtime notification firing

In `tauri/src/notifications.rs`:

```rust
fn resolve_notif_config(
    settings: &Settings,
    event: NotifEvent,
    cwd_key: &str,
) -> NotifConfig {
    settings.projectNotifOverrides
        .get(cwd_key)
        .and_then(|p| p.get(event))
        .filter(|o| o.enabled)
        .cloned()
        .unwrap_or_else(|| settings.notifications[event].clone())
}
```

Resolver is pure → unit-testable.

Playback path resolution:

- `soundPack == "default"` → read from bundled `assets/sounds/<file>`
- other packs → read from `<app-data>/sound-packs/<pack>/<file>`
- Pack referenced but not installed → fall back to the global default for
  that event, and log a warning

## Frontend: Notifications subpage (defaults)

Existing 3 event cards. Sound row becomes two selects + preview button:

```
Type  ○ Sound  ○ Voice
Pack  [Default ▾]   Sound  [Sound 1 ▾]   [▶]
```

- Pack dropdown lists all packs; non-installed packs are greyed with an
  inline "Install" action.
- Picking a non-installed pack prompts install → spinner → on success,
  repopulates the dropdown with installed state and auto-selects the pack.
- Changing pack repopulates the Sound dropdown from that pack's `sounds`.

## Frontend: Project detail page (overrides)

New section appended after the existing "Open project" block:

```
NOTIFICATION OVERRIDES
──────────────────────
Done (Work Finished)              [ Override toggle ]
  ┌ shown when override on ───────────────┐
  │ Type  ○ Sound  ○ Voice                │
  │ Pack  [Peon ▾]  Sound  [Work work ▾] ▶│
  └───────────────────────────────────────┘

Waiting (Question Asked)          [ Override toggle ]
  ...

Threshold Reached                 [ Override toggle ]
  ...
```

Each event row reuses the defaults notif-card template, wrapped by an
override toggle. Voice mode reveals the same voice + message fields as the
defaults.

## Migration

Existing config has bare `notifications[evt].soundFile = "sound1.mp3"` with
no `soundPack` field. On settings load: if `soundPack` missing, inject
`soundPack: "default"`. One-shot, idempotent.

No migration needed for `projectNotifOverrides` (new field, defaults to `{}`).

## Testing

**Rust unit tests** (`cargo test`):

- `resolve_notif_config` returns override when enabled
- returns default when override disabled
- returns default when no override entry for project
- returns default (+ warn) when override references uninstalled pack
- `install_sound_pack` idempotent: second call is no-op
- `install_sound_pack` rejects unknown pack id

**Vitest** (frontend):

- Two-step picker: changing pack repopulates sound options from catalog
- Override toggle: off hides body, on shows body
- Install button triggers `install_sound_pack` and switches state on success

**Manual smoke**:

- Install peon pack, set threshold override on one project, trigger threshold
  event → "Work work" plays
- Uninstalled pack referenced in override → falls back to default, logs warn

## Open items

- Final clip list per pack (curated by Joe from public dumps / own WC3
  install)
- Release asset host location + filename scheme
- Whether to ship a "sample" of each pack bundled (e.g. 1 clip) so users can
  hear the character before installing
- Uninstall flow (delete pack folder, reset overrides that referenced it) -
  deferred, low priority for v1
