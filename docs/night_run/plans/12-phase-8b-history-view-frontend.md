# Phase 8b - History view frontend

## Context

Implements Task 8.3 of `docs/superpowers/plans/2026-05-07-claude-chat-hub.md`. Frontend-only. Depends on Phase 8a (history IPC commands) + Phase 5b (chat-renderer.js).

## Goal

Create `src/modules/history-view.js` and append CSS for `.history-layout` to `src/dashboard.css`. Wire the router so switching to `view-history` calls `activate()`.

## Implementation

`src/modules/history-view.js`:

```js
import { invoke } from '@tauri-apps/api/core';
import { ChatRenderer } from './chat-renderer.js';

let renderer = null;

export async function activate() {
  const root = document.getElementById('history-content');
  let list = [];
  try {
    list = await invoke('list_history', { projectId: null, search: null, limit: 100, offset: 0 });
  } catch (e) {
    root.innerHTML = `<p style="padding:20px;color:#888">No history yet (${escapeHtml(String(e))})</p>`;
    return;
  }
  root.innerHTML = `
    <div class="history-layout">
      <aside class="history-sidebar">
        <input id="history-filter" type="search" placeholder="Search">
        <ul id="history-list">
          ${list.map(h => `<li data-session-id="${escapeHtml(h.session_id)}">${escapeHtml(h.title)}</li>`).join('')}
        </ul>
      </aside>
      <main class="history-pane">
        <div class="history-empty">Pick a past session</div>
      </main>
    </div>
  `;
  root.querySelector('#history-list').addEventListener('click', async (e) => {
    const li = e.target.closest('li[data-session-id]');
    if (!li) return;
    const sessionId = li.dataset.sessionId;
    let events = [];
    try {
      events = await invoke('load_history', { sessionId });
    } catch (err) {
      console.error('load_history failed', err);
    }
    const pane = root.querySelector('.history-pane');
    pane.innerHTML = '<div class="session-messages"></div>';
    if (renderer) renderer.detach();
    renderer = new ChatRenderer(pane.querySelector('.session-messages'));
    renderer.loadHistory(events);
  });
}

export function deactivate() {
  if (renderer) {
    renderer.detach();
    renderer = null;
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
```

CSS in `src/dashboard.css`:

```css
.history-layout { display: flex; height: calc(100vh - var(--header-h, 56px)); }
.history-sidebar { width: 280px; border-right: 1px solid var(--border, #2a2a2a); overflow-y: auto; }
.history-sidebar input { width: 100%; padding: 6px 10px; box-sizing: border-box; }
.history-sidebar ul { list-style: none; margin: 0; padding: 0; }
.history-sidebar li { padding: 8px 12px; cursor: pointer; border-bottom: 1px solid var(--border, #2a2a2a); }
.history-sidebar li:hover { background: var(--accent-bg, #2d4a6e); }
.history-pane { flex: 1; overflow: hidden; display: flex; flex-direction: column; padding: 12px; }
.history-pane .session-messages { flex: 1; overflow-y: auto; }
```

In `src/dashboard.js` router, add the `view-history` activation handler (mirrors `view-sessions`):
```js
'view-history': () => import('./modules/history-view.js').then(m => m.activate()),
```
And on deactivate: call `m.deactivate()`.

## Gotchas

- The `list_history` IPC may return empty array if `~/.claude/sessions/` has no .jsonl files yet. The view shows the "Pick a past session" empty state in that case.
- `escapeHtml` needs to handle session_ids that contain hyphens but no HTML-unsafe chars - safe but escape anyway for paranoia.
- `loadHistory` on the renderer re-triggers a render; no listen() is set up because history is read-only (no live events).

## Don't

- Don't commit.
- Don't add live event listening (no `listen('chat:<id>', ...)`) for history view - it's read-only.
- Don't add a search submit button - the input's existing handler in Phase 5a covers debouncing if any.

## Acceptance

- `src/modules/history-view.js` exists and exports `activate`/`deactivate`.
- `view-history` activates correctly in the router.
- 176 lib tests still pass.
- Reading the file shows graceful degradation when `list_history` fails or returns empty.
