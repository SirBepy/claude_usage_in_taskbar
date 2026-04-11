# TODOs

<!-- last-id: 40 -->

## [T-035] Centralize color application targets
**Status:** planned
**Added:** 2026-04-11
**Easibility:** Easy - UI toggle changes + removing duplicate "Use Colors" checkboxes
**Description:** In the Colors section, add multi-toggle options to define where colors apply (icon, number, dashboard percentages). Remove the separate "Use Colors" checkboxes from the Dashboard and Tooltip sections since this centralizes that control.
**Questions:**
- [x] Toggle style: "Multi-checkbox row - a row of labeled checkboxes for each target (Icon, Number, Dashboard, Tooltip)"

**Plan:**
1. Add a new "Apply Colors To" row in the Colors section of the HTML (will be inside the Visuals page after T-034), with a row of small labeled checkboxes: Icon, Number, Dashboard, Tooltip
2. Add settings keys: `colorApplyTo.icon` (bool), `colorApplyTo.number` (bool), `colorApplyTo.dashboard` (bool), `colorApplyTo.tooltip` (bool) - all default `true`
3. Update `DEFAULT_SETTINGS` in `src/core/settings.js` to include `colorApplyTo`
4. Remove the "Use Colors" toggle from the Dashboard section (`dashboardUseColors`) and Tooltip section (`tooltipUseColors`)
5. Update `saveSettings()` and `window.onload` in `src/renderer/modules/settings.js` to read/write the new `colorApplyTo` fields instead of the old booleans
6. In `src/renderer/dashboard.js` `renderHistory()`: replace references to `currentSettings.dashboardUseColors` with `currentSettings.colorApplyTo?.dashboard !== false`
7. In `src/core/tray.js` tooltip building: replace `tooltipUseColors` with `colorApplyTo?.tooltip !== false`
8. Add a small CSS class for the checkbox row layout (inline flex, gap, small labels)

---

## [T-036] Hide token estimate fields when disabled
**Status:** planned
**Added:** 2026-04-11
**Easibility:** Easy - conditional visibility toggle in JS
**Description:** In the Tooltip settings, when "Remaining Tokens Estimate" is toggled off, hide the session plan and weekly plan input fields instead of leaving them visible but non-functional.
**Questions:**
_(none)_

**Plan:**
1. Wrap the Session Plan and Weekly Plan `<div class="option">` elements in a container div with id `tokenEstimateFields`
2. In `src/renderer/modules/settings.js`, add a `change` listener on `tooltipEstimateTokens` that sets `tokenEstimateFields.style.display` to `tooltipEstimateTokens.checked ? 'block' : 'none'`
3. In the `window.onload` settings hydration, set the initial visibility based on `settings.tooltipEstimateTokens`

---

## [T-037] Add info tooltips for unclear terms
**Status:** planned
**Added:** 2026-04-11
**Easibility:** Easy - add hover info icons with tooltip text
**Description:** Add info icons (i) next to non-obvious settings terms (e.g. "Show Safe Pace", "Time Display") that show an explanatory tooltip on hover.
**Questions:**
- [x] Icon style: "Small circled (i) next to the label, tooltip appears on hover"

**Plan:**
1. Add a `.info-icon` CSS class: small inline circle (14px) with "i" text, dim color, `cursor: help`
2. Add a `.info-tooltip` CSS class: positioned tooltip that appears on `.info-icon:hover + .info-tooltip` or via a wrapper `.info-wrap:hover .info-tooltip`. Dark background, small text, rounded corners, subtle shadow, arrow pointing to the icon
3. Create a reusable HTML pattern: `<span class="info-wrap"><span class="info-icon">i</span><span class="info-tooltip">explanation text</span></span>`
4. Add info tooltips to these settings labels:
   - "Show Safe Pace" -> "Shows what percentage of usage you'd have if you used Claude at a steady rate across the full window"
   - "Time Display" -> "Absolute shows clock time (e.g. 3:45 PM), Countdown shows time remaining (e.g. 2h 15m)"
   - "Remaining Tokens Estimate" -> "Estimates how many tokens you have left based on your plan limits and current usage"
   - "Color Mode: Threshold" -> "Colors change at fixed percentages you define"
   - "Color Mode: Safe Pace" -> "Colors based on whether you're ahead or behind a steady usage rate"
   - "Band %" -> "How close to the safe pace line before the color changes (e.g. 10% means within 10 points)"
5. No JS needed - pure CSS hover tooltips

---

## [T-038] Improve input field styling
**Status:** planned
**Added:** 2026-04-11
**Easibility:** Easy - CSS styling update
**Description:** Improve the look of input fields in settings - they currently look like unstyled browser defaults. Port the full Bepy styleguide input style (inset shadows, multi-tone borders, focus glow).
**Questions:**
- [x] Style approach: "Full Bepy style adapted - port inset shadows, multi-tone borders, and focus glow mapped to app's CSS variables"

**Plan:**
1. In `dashboard.css`, add a proper `input[type="number"]`, `input[type="text"]` rule set ported from the Bepy `.input` class:
   - Background: `var(--surface-alt)` (maps to `--color-background`)
   - Border: `1px solid var(--border)` with subtle top/bottom color variations (`rgba(0,0,0,0.5)` top, `rgba(255,255,255,0.1)` bottom)
   - Inset box-shadow: `inset 0 3px 10px rgba(0,0,0,0.5), inset 0 1px 2px 0 rgba(0,0,0,0.3), inset 0 -1px 1px 0 rgba(255,255,255,0.07), 0 1px 0 0 rgba(255,255,255,0.06)`
   - Focus state: `border-color: var(--primary)` + glow shadow `0 0 0 3px rgba(157,125,252,0.15), 0 0 16px rgba(157,125,252,0.08)`
   - Padding: `0.65rem 1rem`, border-radius: `10px`, font: `'DM Sans'`
   - `appearance: none` + number input spinner styling from Bepy
2. Remove all inline `style=` attributes from `<input>` elements in `dashboard.html` (Session Plan, Weekly Plan, Band %, color threshold min inputs) since the CSS will handle it
3. Also style `select` elements consistently (already partially done, just add the inset shadow treatment)

---

## [T-039] Simplify icon display mode
**Status:** planned
**Added:** 2026-04-11
**Easibility:** Easy - simplify settings, keep existing toggle-through logic
**Description:** Remove the "Display Mode" dropdown from Icon settings. Instead, always enable all 3 tray states (Icon, Session %, Weekly %) with click-to-cycle. Add a "Default Display" option to choose what shows on startup: Icon (default), Session %, or Weekly %. Remove the "Icon & Number" combined option. Keep the icon style setting.
**Questions:**
- [x] Cycle order: "Default first, then the other two. Whatever is set as default shows first, remaining two follow in fixed order."

**Plan:**
1. **HTML** (`dashboard.html` Icon section): Remove the "Display Mode" dropdown (`#displayMode` with icon/number/both options). Replace with a "Default Display" dropdown (`#defaultDisplay`) with options: Icon (default), Session %, Weekly %
2. **Settings** (`src/core/settings.js`): Replace `displayMode` with `defaultDisplay: "icon"` in `DEFAULT_SETTINGS`. Remove `overlayDisplay` from defaults (no longer needed as a persistent setting, the cycle handles it). Keep `overlayStyle`, `colorOverlayMode`, `iconStyle`
3. **Tray** (`src/core/tray.js`): Rewrite `buildDisplayCycle()` to always return 3 states based on `defaultDisplay`:
   - If default is "icon": `[{icon}, {number: session}, {number: weekly}]`
   - If default is "session": `[{number: session}, {number: weekly}, {icon}]`
   - If default is "weekly": `[{number: weekly}, {number: session}, {icon}]`
   - Remove all references to "both" display mode
4. **Settings JS** (`src/renderer/modules/settings.js`): Update `updateVisibilities()` to always show icon style (since icon is always one of the 3 states). Remove conditional hiding of overlay sections. Update save/load for `defaultDisplay` instead of `displayMode`
5. **Icon rendering** (`src/core/icon.js`): Remove any "both" mode rendering logic if it exists
6. Backward compat: if saved settings have old `displayMode`, map `"icon"` -> `defaultDisplay: "icon"`, `"number"` -> `defaultDisplay: "session"`, `"both"` -> `defaultDisplay: "icon"`

---

## [T-034] Merge settings into Visuals page
**Status:** planned
**Added:** 2026-04-11
**Easibility:** Medium - lots of HTML/CSS restructuring, JS nav logic rewiring, but no new features
**Description:** Merge the four separate settings sub-pages (Icon, Tooltip, Dashboard, Colors) into a single "Visuals" page with stacked sections separated by headers. Rename "Sounds" to "Notifications". Restructure the settings nav to:

**General**
- Visuals (single page with Icon, Tooltip, Dashboard, Colors sections stacked)
- Themes (new, see T-040)
- Notifications (renamed from Sounds)
- Launch at Login
- Version
- View Debug Logs (with copy support)

**Account**
- Log out

**Questions:**
- [x] Section layout: "Stacked sections with visible uppercase section titles (ICON, TOOLTIP, DASHBOARD, COLORS)"

**Plan:**
1. **HTML** (`dashboard.html`): Create a new `<div id="view-settings-visuals">` page. Move the contents of `view-settings-icon`, `view-settings-tooltip`, `view-settings-dashboard`, `view-settings-colors` into it as stacked sections, each with a `section-title` header (ICON, TOOLTIP, DASHBOARD, COLORS)
2. Remove the four old view divs (`view-settings-icon`, `view-settings-tooltip`, `view-settings-dashboard`, `view-settings-colors`)
3. Restructure the settings main view nav:
   - Replace the "Visuals" section (with 4 nav-rows) with a single "General" section containing: Visuals nav-row, Themes nav-row (for T-040), Notifications nav-row (rename from Sounds)
   - Move Launch at Login, Version, Debug Logs into this General section
   - Keep Account section with Log Out
4. **JS** (`dashboard.js`): Update `VIEWS` array - remove `"settings-icon"`, `"settings-tooltip"`, `"settings-dashboard"`, `"settings-colors"`, add `"settings-visuals"`. Update nav click handlers
5. **JS** (`dashboard.js`): Remove the 4 old `nav-*` click handlers, add `nav-visuals` click -> `showView("settings-visuals")`. Rename `nav-sounds` to `nav-notifications`
6. **HTML**: Rename "Sounds" heading to "Notifications" in the sounds subpage, update nav label
7. All `.back-to-settings` buttons already handled generically, just ensure the new visuals view has one

---

## [T-040] Add Themes settings page
**Status:** planned
**Added:** 2026-04-11
**Easibility:** Medium - CSS variable remapping, theme file porting, new settings page
**Description:** Add a Themes settings page under General (after Visuals) that lets the user switch between color themes. Port themes from the Bepy styleguide (Void, Nebula, Glacier, Cosmo), each with dark/light mode. The current app hardcodes CSS variables in `:root` - this needs to switch to a `data-theme` attribute system.
**Questions:**
- [x] Theme source: "Port Bepy themes - copy/adapt theme definitions from the Bepy styleguide's themes/ folder"
- [x] Nav placement: "Under General, after Visuals"

**Plan:**
1. **Remap CSS variables**: In `dashboard.css`, replace the hardcoded `:root` variables with the Bepy naming convention (`--color-primary`, `--color-surface`, etc.) OR create a mapping layer. Simpler approach: keep current var names but set them via `[data-theme]` selectors instead of `:root`
2. **Port theme files**: Create `src/renderer/themes/` folder. Port `theme-void.css`, `theme-nebula.css`, `theme-glacier.css`, `theme-cosmo.css` from Bepy, remapping variable names to match the app's existing `--bg`, `--surface`, `--primary`, etc.
3. **HTML**: Add a new `<div id="view-settings-themes">` subpage with theme preview cards or a dropdown/list. Each theme shows a small color swatch preview
4. **Settings**: Add `theme: "void"` to `DEFAULT_SETTINGS` in `src/core/settings.js`
5. **JS**: On theme change, set `document.documentElement.dataset.theme` and save to settings. On load, apply saved theme
6. **Nav**: Add "Themes" nav-row in the General section (after Visuals, before Notifications) in the settings main view
7. Load theme CSS files via a `<link>` tag or inline them into `dashboard.css` since there are only 4

---

## [T-031] Voice notify on AI events
**Status:** planned
**Added:** 2026-04-09
**Easibility:** Easy - straightforward npm TTS lib + settings UI wiring
**Description:** Voice announcement when an AI in a project finishes work or is asking a question (e.g. "An AI in Toolbar is done", "An AI in Toolbar is asking a question").
**Questions:**
- [x] TTS approach: "Use an npm TTS package (say.js or similar) for cross-platform support"
- [x] Project name: "Use the user-assigned project name (falls back to path.basename(cwd)). Configurable via settings checklist."
- [x] Relationship to sounds: "Voice replaces sound effects when enabled. One or the other, not both."

**Plan:**
1. Add `say` (or similar) npm package as a dependency
2. Add voice settings to settings schema: `voice.enabled` (bool), `voice.includeProjectName` (bool)
3. In settings UI (dashboard.html), add a "Voice Notifications" section with toggles
4. In hook-server.js `showNotification` / event handlers: when voice is enabled, call TTS instead of `playSound()`. Build the message string based on user's checklist preferences.
5. Use the project's custom name from settings if available, fall back to `path.basename(cwd)`
6. Test on Windows and (eventually) macOS

---

## [T-032] Native browser sign-in flow
**Status:** planned
**Added:** 2026-04-09
**Easibility:** Medium - the auth flow itself is tricky (getting cookies back from a real browser into Electron), multiple approaches to try
**Description:** Open auth in the user's real default browser with their actual profile instead of an Electron window. Current flow feels sketchy - users have to log into Google in an embedded browser, which will turn off potential users.
**Questions:**
- [x] Auth mechanism: "Any approach that works - localhost callback, deep link, or cookie extraction. Whichever is most reliable."
- [x] Fallback: "Keep the old Electron login window as deprecated code (not deleted) but don't use it. Switch fully to native browser. If the new approach proves unreliable, the old code is still there."

**Plan:**
1. Register a custom protocol handler (`aiusage://`) via Electron's `app.setAsDefaultProtocolClient`
2. When login is needed: start a local HTTP server on a random port, open `claude.ai/login` in the user's default browser via `shell.openExternal`
3. After the user completes OAuth in their real browser, intercept the session cookie via one of:
   - a. Inject a small script on claude.ai that posts the session cookie to the localhost callback server
   - b. Or use the deep link redirect to pass the token back
4. Import the received session cookie into Electron's session store so the scraper can use it
5. Mark the old Electron login window code as deprecated (keep in codebase, don't invoke by default)
6. Add timeout handling - if no callback within ~5 minutes, show a "retry" option
7. Test with Google OAuth flow specifically

---

## [T-033] Cross-device usage sync
**Status:** planned
**Added:** 2026-04-09
**Easibility:** Hard - involves a hosted backend, auth system, MCP server, and cross-platform sync logic. Multiple moving parts.
**Description:** Sync usage data between PC and Mac. Possibly via MCP or similar mechanism, so data can be collected even from machines without the app installed, and could also track normal Claude usage.
**Questions:**
- [x] Storage: "Custom Node.js backend hosted on cheapest available platform (Render, Railway, Fly.io free tier or similar)"
- [x] Self-hosting: "No self-hosting. Use a hosted PaaS for simplicity."
- [x] Non-app machines: "Build an MCP server plugin that runs locally, reads usage data, and pushes to the sync backend. Zero cost, runs on user's machine."

**Plan:**
1. **Backend**: Build a small Node.js/Express API server with endpoints for:
   - User registration/auth (simple API key per device)
   - POST usage snapshots (usage history, token stats)
   - GET merged usage data (aggregated from all devices)
   - Deploy to cheapest free tier (Render/Railway/Fly.io)
   - Use SQLite or free Postgres for storage
2. **App integration**: Add sync module to the Electron app
   - On each poll cycle, push new usage data to the backend
   - Periodically pull merged data from all linked devices
   - Settings UI: sync enable/disable, device name, API key setup
3. **MCP server**: Build a standalone MCP server package
   - Reads local Claude usage data (settings files, JSONL logs)
   - Exposes tools for Claude Code to query local usage
   - Pushes data to the sync backend on a schedule
   - Installable via `npx` or as a Claude Code MCP config entry
4. **Device linking**: Simple flow - generate API key on first device, enter it on second device to link them
5. **Data merge**: Server merges snapshots by timestamp, deduplicates, returns unified view

---
