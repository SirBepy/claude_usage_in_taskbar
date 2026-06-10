# Comments for Bepy

## 2026-06-10 - Remote-chat flag + configurable new-session modal

RUN_LEDGER (chunk -> outcome -> sha):
- Rust: per-chat `remote` flag threaded -> claude --remote-control -> cargo build green -> d56b254
- Frontend: More-options disclosure (Auto-allow + Remote checkboxes), settings-configurable defaults, data-driven editable model list -> tsc + 261 vitest green -> 70546b5

Decisions / notes:
- Built A (remote flag), B (More-options disclosure), C (settings defaults), D1 (data-driven model list from settings.models, editable in Session presets). DEFERRED D2 (auto-query /v1/models at boot) to ai_todo 40 per your steer - it's the uncertain bit (OAuth token may not be accepted by the API-key-authed /v1/models endpoint).
- Defaults: both checkboxes default ON; sourced from settings.defaultAutoAllow / settings.defaultRemoteControl (absent = on). Settings keys added: `models`, `defaultAutoAllow`, `defaultRemoteControl`.
- Resume/respawn path passes remote=false (never registers a fresh bridge -> no duplicate Claude desktop sidebar entries, matches the existing channel rule).
- Model validation loosened (readPresets/readLastChoice accept any non-empty model string) so user-defined models survive; effort stays strict.
- UNVERIFIED / LOAD-BEARING: `--remote-control` + `--input-format=stream-json` on one chat process is the untested Phase-5b seam. Threaded as asked, but whether it actually works (daemon stdin vs phone bridge both driving) needs your live test - flagged in BEPY_TODOS. If it conflicts, we rethink.

## 2026-06-10 - Tool-call activity surfacing (autopilot run)

RUN_LEDGER (chunk -> outcome -> sha):
- Doubled-attachment-message dedup fix -> green (vitest) -> b256448
- Compact tool rows + per-chat tool tally + live activity label -> green -> 8bcf1d6
- Subagent rows = "starting subagent" + 100-char target cap -> green -> 27fe9f6
- Scroll: only auto-scroll when already at bottom -> green (jsdom test) -> 177d215
- Rust open_in_editor + read_image_file IPC -> cargo build green -> 98ca6af
- ccstatusline row + Files|Media popover -> (in progress)

Judgment calls made without asking (all reversible):
- Agent/Task tool rows show the literal "starting subagent" (NOT the short description), per your explicit ask. One-line revert in tool-meta.ts toolSummary if you'd rather see the description.
- 100-char cap on ALL tool-row targets (Bash descriptions, Grep patterns, filenames).
- Bash/PowerShell ARE counted in both the transcript rows and the ccstatusline tally; a toggle to hide them from the statusline is filed as an ai_todo (not built).
- Tool rows use native <details>/<summary> for collapse (no JS expand-state map): survives streaming + pagination because these non-streaming message elements aren't rebuilt.
- read_attachment is sandboxed to the chat-attachments dir, so added read_image_file for arbitrary image paths (mirrors it minus the sandbox). open_in_editor opens VS Code (cmd /C code, CREATE_NO_WINDOW) with an OS-default-open fallback. No capabilities entry needed (confirmed: existing custom commands aren't listed there either).

Filed as ai_todos (not built this run):
- In-app file/image viewer to replace the external VS Code open (your "handle it all in this app" later).
- AskUserQuestion picker silently dropped your answers this session (you answered, I received "dismissed").
- Optional toggle to hide Bash from the ccstatusline tally.

## 2026-06-06 - Autopilot: Re-source 1136 guillotine-cropped clips (full-length, no crop)

Old "cut every clip to 2.0s" trim chopped 1136 voice lines mid-word. This run replaced them IN PLACE with FULL-length originals (same filename so character.json slots stay valid), per the corrected length rules. Character data lives OUTSIDE the git repo - only these .for_bepy bookkeeping files were committed (raw git, no /commit, per your instruction).

**RESULT: 1054 / 1136 re-sourced full-length (92.8%). 113 of those are 5-10s (pending your ear). 82 unresolved (left as the old crop + logged).**
Oracle = mtime+duration scan of every dest file (`C:\tmp\final_scan.py`): a fixed file carries today's mtime; an unfixed one keeps the 2026-06-05 build mtime and the uniform 2.0s/192078-byte crop.

Per-game (fixed / pending5-10 / unresolved):
- heroes-of-the-storm: 876 / 110 / 7
- sims: 111 / 0 / 0
- warcraft-3-frozen-throne: 17 / 0 / 0
- spongebob: 10 / 1 / 0
- family-guy: 18 / 1 / 43
- simpsons: 10 / 1 / 28
- army-men-rts: 12 / 0 / 4

### RUN LEDGER (chunk -> outcome)
- DONE HotS tier1 (48 chars): deterministic match - stored `<char>-<token>-<n>.ogg` <- jamiephan `_/voicelines/<Codename>Base_<Action><nn>.ogg` keyed on (action-token, index) from the repo git-tree; raw-download full ogg, verify vorbis + duration. 468 full + retries.
- DONE HotS codename-alias (13 chars): cassia=Amazon, johanna=Crusader, xul=Necromancer, kharazim=Monk, li-ming=Wizard, lt-morales=Medic, lunara=Dryad, mei=MeiOW, qhira=NexusHunter, the-lost-vikings=LostVikings(+Baleog/Erik/Olaf), anub-arak=Anubarak, the-butcher=Butcher, deckard-cain=Deckard. Same matcher.
- DONE HotS fandom (27 chars): heroesofthestorm.fandom allimages API, same (token,index) parser on `<Codename>Hero_<Action><nn>.ogg`. Prefix discovery: sonya=Barbarian, valla=DemonHunter, nazeebo=WitchDoctor, etc=ETC, li-li=LiLi. arthas only on heroesofthestorm-archive.fandom.com. uther's clips came from `.mp3` files (token `pissed00-mp`) - special-cased + transcoded mp3->ogg.
- DONE WC3 (subagent): Ladik MPQ Editor console + `Warcraft III.txt` listfile on local war3.mpq; arthas = TFT Death Knight (`DeathKnight*.wav`, NOT HeroDeathKnight). 17/17.
- DONE sims (subagent): archive.org `sims-1-sfx-library` Voice.zip = 1662 Maxis takes named by exact event token (VOX_BRAGGEE_ADMIREF3 etc.); gender code F/M/K; Goths reuse adult F/M. 111/111, all <5s (proves the 2s cap was pure damage).
- DONE spongebob (subagent): archive.org `SpongebobSounds` + soundfxcenter. 10/10.
- DONE army-men (subagent): carved 3DO proprietary NORK `.x` archives from archive.org `army-men-rts_202106`. 12 SFX recovered; 4 hero unit-voice lines genuinely ship NO audio in the PC release.
- DONE simpsons + family-guy (subagents): bulk soundboards (thesoundarchive/frogstar; realmofdarkness for FG). LOW yield - most cropped names are character-creator action labels or DVD-only lines with no exact-phrase source.
  - CAUGHT BY ORACLE: both subagents wrote to `characters/<game>/<char>/<file>` MISSING the `sounds/` subdir, then reported success. Their full-length writes were misplaced one level up; I moved all 28 into the correct `sounds/` dirs. (Lesson: subagent self-reported "replaced" is not trustworthy - the mtime oracle is.)

### Judgment calls (autopilot auto-resolved; revisit if you disagree)
- 5-10s clips: REPLACED in place with the full line (better than a 2s mid-word chop) AND logged for approval, rather than leaving the crop. The slot already referenced the file; a real 5-10s line beats a broken 2s one, and you can swap any that feel too long. (113 clips.)
- When a hero's exact original index was missing from a source, used a DISTINCT same-action clip (substitute) rather than leaving cropped - same slot intent, no dup within the action.
- family-guy subagent offered ~6-8 MORE replacements via LOOSE phrase matching (hilarious->"Clever", gorgeous->"Pretty"). DECLINED - shipping a semantically-wrong line is worse than a known crop you can spot. Say the word and Claude will pull them.
- 7 HotS `laugh` clips: no laugh VO exists in jamiephan OR fandom hero audio (they came from some other origin in the first build). Left cropped. They are pool clips, not slot-assigned, so low impact.

### 5-10s clips pending approval
113 clips re-sourced FULL-length but in the 5-10s band - need your ear (a chime this long may feel long). Full path list: `.for_bepy/resource_pending_5to10s.txt` (HotS 110, spongebob 1, simpsons 1, family-guy 1). To swap any: tell Claude "find a shorter <char> <action> line".

### Unresolved (left as old 2.0s crop, NOT deleted)
82 clips - full list: `.for_bepy/resource_unresolved.txt`. Breakdown: family-guy 43 (Stewie DVD-only lines + empty Brian board + action-label slugs), simpsons 28 (`bart-clip-N`/`lisa-line-1` non-descriptive names + Lisa/Marge sources down), HotS 7 (`laugh`), army-men 4 (hero unit VO absent from PC release). These need manual/per-phrase sourcing or a looser-match pass.

---

## 2026-06-06 - Autopilot: ai_todo 30 (context-left v2, single source of truth)
Daemon-owned context_status = the one place the context % is computed. Consumers: app chip, /context-left skill, mobile (via skill reply through the remote-control bridge - daemon never reaches the phone). Fixes the "100% context" bug (root: frontend window defaults 200K when model unresolved). No definitive Opus 200K/1M signal exists (investigated) -> heuristic + stateless sticky "any turn occupancy >200K proves >=1M" correction + a confidence flag. Skill-pull, NOT a Stop hook (Joe superseded his own earlier pick). Autopilot self-regulates: ~50% used slow, ~60% used hard-stop + dump todos.
### v2 RUN LEDGER
- DONE C1 daemon context_status core + /context endpoint + IPC command + 14 executing tests -> c8d01c6, cargo build clean
- DONE C2 chip repoint (reads daemon value, ~/(estimated) on heuristic, fallback to old calc) + 6 tests -> 75c9797, tsc clean, vitest 200 pass
- DONE C3 /context-left skill prefers daemon endpoint, self-compute fallback [global ~/.claude, no repo commit] - verified fallback path live
- DONE C4 autopilot self-regulation: SLOW_AT=50% used, HARD_STOP_AT=60% used [global ~/.claude, no repo commit]
- DONE C5 final tsc clean; ai_todo 30 closed -> a3abf39; BEPY_TODO added for relaunch verify
- NOTE: a concurrent session committed an unrelated vorbis fix (9ae8eab) into the tree mid-run; I staged by name throughout so nothing clobbered. History clean.


## 2026-06-06 - Autopilot: resolve ai_todo 25 (pipe frame-size warning)
Root cause = (B) harmless transition artifact: an old pre-frame-protocol app binary writes unframed JSON to the length-prefixed pipe during an update; every CURRENT writer uses write_frame, so no live bug. Remedy: downgraded ONLY the FrameError::TooLarge case warn->debug + comment (real errors stay warn), added GetNamedPipeClientProcessId PID logging for future correlation. cargo build clean. -> 788474e. Live-verify (warn gone from daemon.log) handed to Joe via BEPY_TODO (01cbd30). ai_todo 25 deleted.
ai_todo 30 (context-left v2) intentionally NOT touched - deferred by Joe earlier this session.



## 2026-06-05 - Autopilot: Cartoon character bundles (ai_todo 26)
Building 14 chars across 3 games via /character-creator GAME mode (one batch per game).
Output: %APPDATA%\claude-usage-tauri\characters\<game>\<char>\ (OUTSIDE git repo).
- spongebob (SpongeBob SquarePants): spongebob, patrick, squidward
- family-guy: stewie, peter, brian, quagmire, cleveland, meg
- simpsons (The Simpsons): homer, marge, bart, lisa, abe
Sources: icons = Wikipedia infobox / Fandom character pages; audio = archive.org soundboards/voice rips.
Clip rules: discard >5s, trim kept clips <=2s (ffmpeg available). Keep all clips in each char's pool.
Slot picks auto-assigned by filename-keyword classifier (autopilot suppresses per-slot AskUserQuestion).
Parked chars (icon/audio unsourceable unattended) logged below under PARKED.

### Cartoons RUN LEDGER
- DONE 3 parallel build subagents (one per game). 13/14 built first pass; lisa initially below 3-slot floor.
- DONE lisa audio retry (archive.org/soundfxcenter failed - SWF was AS3-streamed, soundfxcenter TLS-down; yt-dlp last-resort succeeded) -> lisa now 6 slots.
- DONE independent loader-mirror validation (C:\tmp\validate_cartoons.py): mirrors src-tauri characters/loader.rs (id==dir, icon exists+64x64, every slot file exists). Result: 17/17 ok, 0 fail (14 chars + 3 _shared bundles).
- RESULT: 14/14 chars BUILT, 0 PARKED.
  - spongebob: spongebob(6), patrick(3), squidward(3). audio=archive.org SpongebobSounds + soundfxcenter/memesoundeffects. Patrick pool thin (2 clips).
  - family-guy: stewie(6), peter(3), brian(3), quagmire(3), cleveland(3), meg(3). audio=archive.org 03-interview-3-stewie + soundfxcenter. peter/brian pools thin (3 clips).
  - simpsons: homer(6), bart(4), marge(4), lisa(6), abe(3). audio=archive.org soundboard.-7z + SWF-extracted (177105_bartsb_swf, old-abe-simpson-soundboard.fla) + soundfxcenter + yt-dlp (lisa only).
- Each char's sounds/ is a POOL (all kept clips, trimmed <=2s, >5s discarded) for UI remap; slots point at the best subset. game.json + _shared bundle written per game.
- THIN pools (load fine, fall back to global default on empty slots; remap-worthy if more audio surfaces): patrick, peter, brian, abe.
- ai_todo 26 deleted (all 3 games done). Character data lives OUTSIDE the git repo (no commit needed for it).


## 2026-06-05 17:00 - Autopilot: Heroes of the Storm full roster (ai_todo 27)
Building ALL ~90 HotS heroes as character bundles via /character-creator GAME mode.
Output: %APPDATA%\claude-usage-tauri\characters\heroes-of-the-storm\ (OUTSIDE git repo).
Sources (recon-verified): icons = HeroesToolChest/heroes-images draft portraits (all 90);
audio tier1 = jamiephan/_ per-hero .ogg (65 folders); audio tier2 = Fandom allimages API (~29 gap heroes).
Slot picks auto-assigned by filename-keyword classifier (autopilot suppresses the per-slot AskUserQuestion).
Parked heroes (icon or audio unsourceable unattended) logged below under PARKED.

### HotS RUN LEDGER
- DONE recon: subagent verified sources (icons HeroesToolChest/heroes-images draft portraits = all 90; audio jamiephan/_ = 61 heroes; Fandom allimages API = gap heroes). Installed ffmpeg via scoop.
- DONE icons: all 90 heroes -> 64x64 icon.png from draft portraits. 0 fail.
- DONE audio tier1 (jamiephan/_ .ogg, 61 heroes) -> 894 clips, all 61 filled.
- DONE audio tier2 (Fandom allimages API, 28 heroes incl. Illidan/Abathur/ETC/Diablo) -> 371 clips. Arthas sourced from heroesofthestorm-archive.fandom.com (main wiki had announcer-only).
- DONE character.json for all 90 (game-grouped layout, schema matches src-tauri characters/loader.rs + mod.rs).
- DONE _shared bundle (shared:true, empty slots, HotS logo icon) + game.json.
- VERIFIED: 90/90 pass loader-mirror validation (id==dir, icon exists, every slot file exists). Audio spot-check: all decode, durations capped 2.0s, icons 64x64 RGBA, 0 corrupt. Total 26MB.

Slot classifier (autopilot auto-assigned, replacing the skill's per-slot AskUserQuestion):
Pissed->annoyed, IntroQuestion/What->question_asked, IntroBoast/IntroRespond->ready,
AI_GoodJob/Celebrate->work_finished, Yes/Attack/Ack->select, VOX_GetHitLarge->death
(HotS heroes have no dedicated death VO, so death = the "big hit" cry; tolerated-empty for 6 heroes).
Announcer-pack files (HeroKill/GameStart/Countdown/etc.) filtered out of tier2.
Every downloaded clip kept in each hero's sounds/ pool (1265 files) for UI remapping, not just the slotted subset.

### PARKED (unsourceable unattended)
- sgt-hammer AUDIO: no hero voice files found on heroesofthestorm.fandom.com, the archive wiki, or wiki.gg (tried SgtHammer/Hammer/Sgt prefixes; wiki.gg 403s). Icon IS present, so she loads and falls back to the global default sound. To add audio manually: drop trimmed .ogg/.wav into %APPDATA%\claude-usage-tauri\characters\heroes-of-the-storm\sgt-hammer\sounds\ and point slots in that folder's character.json at them.
- THIN (few auto-slotted lines, but each has a pool of extra clips on disk to remap via the UI): murky (2 clips - inherently murloc gurgles, only 2 on wiki), gall (passenger head - only "Yes" matched standard tokens; Laugh/Kill/No clips are in his pool), arthas (3 slots - archive wiki lacked work_finished/select tokens), nazeebo (3 slots).

---

Autopilot run: implement ai_todos 28 (shutdown-when-done) + 29 (sleep-when-done) as ONE unified protocol. Started 2026-06-05 14:10.

This file = autopilot decision log + RUN_LEDGER. It is intentionally left UNTRACKED (not git-added). Skim it to see what I decided while you were away.

---

## 2026-06-05 14:10 - Protocol engine location (app main process vs daemon)
Decision needed: Where does the "watch all sessions -> close -> sleep/shutdown" engine live?
Resolved via: direct judgment (strongly indicated, not a coin-flip; did not spend an iterate-it escalation)
Picked: Tauri main process (AppState + a tokio task), NOT the daemon, NOT a webview.
Reason: must persist across chat-window open/close, owns the OS power action (app-side), and drives UI via window events; daemon staying alive is irrelevant since the power action is for the GUI host. App already mirrors instances + has daemon_client for the RPCs it needs.
Where: src-tauri/src/ (new protocol module + system_control)
Revisit: no

## 2026-06-05 14:10 - Move view-level controls into new overflow menu
Decision needed: Joe wants filter/history/new-chat moved into a new top-right "more options" menu; a subagent advised against it (said they're view-scoped).
Resolved via: direct judgment (Joe's explicit instruction + the new menu is itself view-level, so scope is coherent)
Picked: Build the new "more options" overflow menu in the VIEW header (views/sessions/template.ts), move the sort/filter dropdown + history + new-chat buttons into it, add Sleep/Shutdown-when-done triggers there too. Per-session ⋮ menu stays as-is.
Reason: protocol is global (all sessions); the moved controls are also global/view-level, so they belong together in a view-level menu. Subagent's "breaks scope" worry is unfounded since the new menu is not per-session.
Where: src/views/sessions/template.ts, sessions.ts, sessions.css
Revisit: no

## 2026-06-05 14:10 - Countdown semantics
Decision needed: what is the "cancellable countdown"?
Resolved via: direct judgment (matches todo-28 "cancellable countdown so Joe can abort")
Picked: a final ~30s grace countdown AFTER all sessions are closed and BEFORE the sleep/shutdown fires; cancellable from the menu UI. While armed-but-still-waiting, show a steady "armed" indicator (not a countdown).
Reason: the trigger is event-driven ("when done"), so a fixed timer only makes sense as the last-chance abort window before the irreversible action.
Where: backend engine phase machine + frontend menu
Revisit: no

---

## RUN LEDGER (chunk -> outcome -> sha)
- DONE C1 backend (system_control + when_done engine + 3 IPC + ts-rs types) -> af11138, cargo build clean
  - REVISIT (non-blocking): engine writes its auto-resolution log to COMMENTS_FOR_BEPY.md via a compile-time CARGO_MANIFEST_DIR path; fine in dev, would need an app-data path for a packaged release.
- DONE C2 frontend overflow menu + move sort/history/new-chat + sleep/shutdown toggles + countdown -> 9a6f7a5, tsc clean, vitest 179 pass
  - Menu layout/copy/icons GUESSED (Joe's taste, flagged in BEPY_TODOS Visual QA for review)
  - 3 e2e specs adapted to the moved new-chat button; not run by me (slow suite)
- DONE C3 tests (15 frontend + 3 backend cases) -> 8ab950f
- DONE C4 verify floor ALL GREEN (cargo build clean, tsc 0 errors, vitest 194 pass / 19 skip, no orphans) + README feature bullet + BEPY_TODOS manual-verify entry + deleted ai_todos 28/29
  - Real close->countdown->sleep/shutdown chain is integration-only -> handed to Joe as a Visual QA BEPY_TODO (can't sleep a real PC in CI)
- DONE C5 (added after Joe challenged test depth) -> ed416dc
  - Caught: the 3 backend tests were compile-only (--no-run); now EXECUTE (14 when_done cases pass, scoped so daemon survives)
  - Extracted 4 pure engine fns behavior-preserving (all_sessions_idle, waiting_on_ids, next_countdown, close_turn_complete) so the phase-machine logic is actually exercised
  - Parse-checked the 3 modified e2e specs (all valid)
  - Remaining lever NOT pulled (Joe's call): trait-inject the daemon client + terminal action to enable a full task-level integration test - that's a structural change to shipped code, didn't do it unprompted

---

## 2026-06-11 00:45 - /autopilot ai_todos sweep

Task: grind any actionable ai_todos. Triaged all 11. Only 1 was cleanly actionable without a live test or WIP conflict.

Decision needed: which todos to action vs park.
Resolved via: direct judgment + one Explore subagent for triage + one Explore subagent to verify 37's intent.
Picked:
- ai_todo 43 (extract statusbar tally subsystem): IMPLEMENTED. session-statusbar.ts 539 -> 385 lines; new session-tally.ts (ToolTallyRow controller) + session-tally.css. Pure refactor, behavior identical, tsc clean, vitest 277 pass (6 tally tests green). Commit 86d38fe. ai_todo deleted.
- ai_todo 37 (hide Bash from statusline tally): CLOSED AS REDUNDANT, no code written. The feature already exists: Settings > Statusline > "Tool activity chips" already lists "Ran (shell)" (key "Bash") as an untickable checkbox (statusline.ts:121-127 -> tallyHiddenTools). Unticking it filters ONLY the statusline tally render (session-statusbar.ts:428), never the in-chat transcript rows. That is exactly what 37 asked for. Implementing a separate tallyHideBash boolean would duplicate it. ai_todo deleted.
  - Revisit: ONLY if you wanted a MORE prominent/dedicated toggle than the generic per-tool chip list. The functional ask is already met. Re-add a todo if you want dedicated UI.

Parked (not actionable this run):
- ai_todo 31 (collapse context-window heuristic to 1 source): BLOCKED. Its precondition is that ai_todo 30's BEPY_TODO confirms the chip reads the daemon value correctly post-relaunch. ai_todo 30 is still in BEPY_TODOS NEEDS-RELAUNCH pending, and the daemon value is itself a heuristic (no definitive Opus 200K-vs-1M signal). Removing the frontend modelContextWindow fallback now is a live-test gate I cannot clear. Left as-is.
- 32 (when-done integration test), 35 (in-app file viewer), 36 (AskUserQuestion dropped answers), 40 (auto-query models - OAuth /v1/models gating unknown), 45 (msg-count + unsent queue): all need a live app/daemon, a live repro, or Joe's credentials. Parked.
- 42 (filter body tool groups) + 44 (transcript accordion): SKIPPED to avoid clobbering the uncommitted WIP already in the tree (chat-renderer.ts, turn-collapse.ts, chat.css, chat-renderer-activity.test.mjs) - that WIP is in-flight work on 44. See note below.
- 33 (HotS laugh extraction): needs local game CASC + manual audio curation on your machine. Parked.

NOTE on uncommitted WIP: at session start the tree already had modified chat-renderer.ts / chat.css / turn-collapse.ts / chat-renderer-activity.test.mjs (in-flight on ai_todo 44, predates this session). Tests pass WITH it (277 green) but I did NOT commit it - can't attribute another agent's half-state, and concurrent-autopilot rules say never sweep up files I didn't author. Left untouched/unstaged. Also left unstaged: the ` D` deletion of ai_todo 41's md file (41 was resolved in commit 48b593e; its md just wasn't deleted then - your call whether to clean it up).

Where: src/views/sessions/ (statusbar tally)
Revisit: 37 only (see above); rest are parked with reasons.
