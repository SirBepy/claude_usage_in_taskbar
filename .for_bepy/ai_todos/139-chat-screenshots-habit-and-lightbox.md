---
id: 139
title: Habit of surfacing AI screenshots in chat + click-to-fullscreen lightbox
priority: medium
area: frontend / chat + convention
status: todo
---

## What

Two related things:

1. **Make it a habit** that when the in-app AI takes a screenshot that might be interesting for Joe to see (a test run, a rendered page, a visual result), it surfaces it INLINE in the chat by default - not just as a file path or prose. This is a convention nudge, not just a capability.
2. **Click-to-fullscreen lightbox:** any image in the chat (AI screenshot OR Joe's pasted attachment) is clickable and opens full-screen, with the usual viewer affordances (Esc / click-backdrop to close, fit-to-screen, ideally prev/next across the images in that message or conversation).

## Why

Joe wants visual results to land where he is (the conversation) and be easy to inspect at full size, instead of hunting for a file or squinting at a small inline thumbnail.

## Relationship to other todos

- **Todo 132** (AI takes screenshots and shows them inline) is the prerequisite for part 1 - it builds the mechanism to get the image into the chat at all (path-validated `read_attachment` serving, sentinel/convention). This todo's part 1 is the *habit/convention layer* on top: teach the AI (via the todo 136 injected instructions and/or CLAUDE.md) to proactively screenshot + surface when a result is visual, without being asked each time.
- **Todo 136** (inject formatting instructions on new chat) is the natural home for the "when you produce a visual result, capture + surface it" rule.
- **Todo 138** (HTML preview window) is a sibling: both are "AI surfaces a visual in the app." The lightbox here and the preview canvas there could share a viewer component / zoom behavior.

## Scope notes (settle at build time)

- Lightbox should work on BOTH the desktop webview and the phone PWA (images already serve through the phone-mapped `read_attachment` route, so the viewer is frontend-only).
- "Interesting enough to surface" is a judgment call - keep the convention light (surface on visual results / on request), don't auto-spam every screenshot. Explicit-or-on-request first, broaden later.
- Prefer a built-in/lightweight lightbox over a library (platform primitive over dependency, per global rules).

## Open UX question (decide with Joe at build time)

Should "click to enlarge" use a dedicated lightbox, or open the image in the **todo 138 preview window's canvas** (which already does fullscreen / zoom / device-width)?

- Claude's lean: keep the screenshot landing INLINE in chat (anchored to the turn that produced it - that context is the point, and a separate image shouldn't get clobbered by the next push). But route "enlarge" into the preview-window canvas rather than building a separate lightbox. One big-viewer surface, two entry points (a chat image, or a pushed HTML preview). Less to build; the two features reinforce each other.
- Joe was unsure and wants to revisit. NOT decided - this is [UX], Joe's call on feel.

## Success criteria

- Clicking any chat image opens it full-screen; Esc / backdrop closes it; works desktop + phone.
- The AI reliably surfaces visual results inline without being re-told each turn (convention lands in the injected instructions / CLAUDE.md).
- No regression to existing pasted-attachment image rendering.
