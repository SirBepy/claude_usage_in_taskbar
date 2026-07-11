// Drag + flick-to-corner for the floating overlay window (milestone 06 UI
// polish). The whole card stack is a drag surface: press and move to reposition
// the native window, and release with speed to "throw" it — it flies to the
// corner in the direction of the flick and parks there, keeping its trajectory.
// A slow release just leaves it where you dropped it. Either way the final spot
// is persisted (save_overlay_position) so a tray toggle reopens it in place.
//
// We drive this from JS rather than the native CSS `-webkit-app-region: drag`
// because the OS-native drag hides the intermediate positions from the webview,
// so there'd be no velocity to read for the flick. All coordinates are physical
// pixels (what the Tauri window position/size APIs speak).

import { api } from "../../shared/api";

// withGlobalTauri = true, so the window API lives on the global. Typed loosely;
// there are no bundled @tauri-apps/api types in this frontend.
interface TauriWindowApi {
  getCurrentWindow: () => TauriWindow;
  // currentMonitor is a MODULE-level function in @tauri-apps/api/window, NOT a
  // Window method — calling it off the window instance returns undefined and
  // throws, which silently killed the flick before this was fixed.
  currentMonitor: () => Promise<Monitor | null>;
  PhysicalPosition: new (x: number, y: number) => unknown;
  LogicalSize: new (w: number, h: number) => unknown;
}
interface TauriWindow {
  scaleFactor: () => Promise<number>;
  outerPosition: () => Promise<{ x: number; y: number }>;
  outerSize: () => Promise<{ width: number; height: number }>;
  setPosition: (p: unknown) => Promise<void>;
  setSize: (s: unknown) => Promise<void>;
}
interface Monitor {
  position: { x: number; y: number };
  size: { width: number; height: number };
}

function tauriWindow(): TauriWindowApi | null {
  return (window as unknown as { __TAURI__?: { window?: TauriWindowApi } }).__TAURI__?.window ?? null;
}

/** Release speed (physical px/ms) at or above which a drag counts as a flick. */
const FLICK_SPEED = 0.35;
/** Pointer travel (physical px) before a press counts as a drag rather than a
 * click. Now that the whole panel is the drag surface (no dedicated grip), this
 * keeps a click-to-open-dashboard from being swallowed by tiny cursor jitter. */
const DRAG_THRESHOLD = 5;
/** How long the fly-to-corner animation runs. */
const SNAP_MS = 380;
/** Inset from the screen edges when parking in a corner (logical-ish px, scaled). */
const CORNER_MARGIN = 12;
/** Extra bottom inset so a bottom corner clears the Windows taskbar. */
const TASKBAR_MARGIN = 48;

interface Sample { t: number; x: number; y: number }

/**
 * Wire drag + flick onto `surface` (the whole overlay panel). Returns a cleanup
 * that removes every listener. `onClick`, if given, fires on a press that never
 * crossed the drag threshold (a plain click), receiving the original
 * pointerdown target — the surface takes pointer capture on press, so the
 * native `click` event can't be relied on to reach the pressed child. No-op
 * (returns a bare cleanup) when the Tauri window API is unavailable (e.g.
 * running the view in a plain browser).
 */
export function initOverlayDrag(surface: HTMLElement, onClick?: (target: EventTarget | null) => void): () => void {
  const maybeApi = tauriWindow();
  if (!maybeApi) {
    // Still support click-to-open in a plain browser (no window API to drag).
    if (onClick) {
      const click = (e: MouseEvent): void => onClick(e.target);
      surface.addEventListener("click", click);
      return () => surface.removeEventListener("click", click);
    }
    return () => {};
  }
  // Typed non-null so the nested drag closures see it as present (TS won't
  // carry the early-return narrowing into closures created later).
  const w: TauriWindowApi = maybeApi;
  const appWin = w.getCurrentWindow();

  let dragging = false;
  let moved = false;
  let scale = 1;
  let startWin = { x: 0, y: 0 };
  let startPtr = { x: 0, y: 0 };
  let cur = { x: 0, y: 0 };
  let samples: Sample[] = [];
  let downTarget: EventTarget | null = null;

  async function onDown(e: PointerEvent): Promise<void> {
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    downTarget = e.target;
    try { surface.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    scale = await appWin.scaleFactor();
    const pos = await appWin.outerPosition();
    startWin = { x: pos.x, y: pos.y };
    cur = { ...startWin };
    startPtr = { x: e.screenX * scale, y: e.screenY * scale };
    samples = [{ t: e.timeStamp, x: startPtr.x, y: startPtr.y }];
    document.body.classList.add("oc-dragging");
  }

  function onMove(e: PointerEvent): void {
    if (!dragging) return;
    const px = e.screenX * scale;
    const py = e.screenY * scale;
    // Until the pointer clears the threshold, treat the press as a potential
    // click and don't move the window at all.
    if (!moved && Math.hypot(px - startPtr.x, py - startPtr.y) < DRAG_THRESHOLD) return;
    moved = true;
    const nx = Math.round(startWin.x + (px - startPtr.x));
    const ny = Math.round(startWin.y + (py - startPtr.y));
    cur = { x: nx, y: ny };
    void appWin.setPosition(new w.PhysicalPosition(nx, ny));
    samples.push({ t: e.timeStamp, x: px, y: py });
    if (samples.length > 6) samples.shift();
  }

  async function onUp(e: PointerEvent): Promise<void> {
    if (!dragging) return;
    dragging = false;
    try { surface.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    document.body.classList.remove("oc-dragging");
    if (!moved) { onClick?.(downTarget); return; } // a plain click, not a drag

    const last = samples[samples.length - 1];
    const first = samples[0];
    if (!last || !first) { await clampOnscreen(); return; }
    const dt = Math.max(1, last.t - first.t);
    const vx = (last.x - first.x) / dt;
    const vy = (last.y - first.y) / dt;
    if (Math.hypot(vx, vy) >= FLICK_SPEED) {
      await flickToCorner(vx, vy);
    } else {
      await clampOnscreen();
    }
    try {
      const finalPos = await appWin.outerPosition();
      await api.saveOverlayPosition(finalPos.x, finalPos.y);
    } catch (err) {
      console.error("overlay: persist position failed", err);
    }
  }

  /** Physical corner top-lefts for the current monitor + window size. */
  async function corners(): Promise<{ left: number; right: number; top: number; bottom: number } | null> {
    const mon = await w.currentMonitor();
    if (!mon) return null;
    const size = await appWin.outerSize();
    const m = Math.round(CORNER_MARGIN * scale);
    const bm = Math.round(TASKBAR_MARGIN * scale);
    return {
      left: mon.position.x + m,
      right: mon.position.x + mon.size.width - size.width - m,
      top: mon.position.y + m,
      bottom: mon.position.y + mon.size.height - size.height - bm,
    };
  }

  async function flickToCorner(vx: number, vy: number): Promise<void> {
    const c = await corners();
    if (!c) return;
    const tx = vx > 0 ? c.right : c.left;
    const ty = vy > 0 ? c.bottom : c.top;
    await animateTo(tx, ty);
  }

  function animateTo(tx: number, ty: number): Promise<void> {
    return new Promise((resolve) => {
      const sx = cur.x;
      const sy = cur.y;
      const t0 = performance.now();
      const ease = (t: number): number => 1 - Math.pow(1 - t, 3);
      const frame = (now: number): void => {
        const t = Math.min(1, (now - t0) / SNAP_MS);
        const k = ease(t);
        const x = Math.round(sx + (tx - sx) * k);
        const y = Math.round(sy + (ty - sy) * k);
        cur = { x, y };
        void appWin.setPosition(new w.PhysicalPosition(x, y));
        if (t < 1) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
  }

  /** Nudge a dropped window fully back on-screen if it overhangs an edge. */
  async function clampOnscreen(): Promise<void> {
    const c = await corners();
    if (!c) return;
    const x = Math.max(c.left, Math.min(c.right, cur.x));
    const y = Math.max(c.top, Math.min(c.bottom, cur.y));
    if (x !== cur.x || y !== cur.y) {
      cur = { x, y };
      await appWin.setPosition(new w.PhysicalPosition(x, y));
    }
  }

  const down = (e: PointerEvent): void => void onDown(e);
  const move = (e: PointerEvent): void => onMove(e);
  const up = (e: PointerEvent): void => void onUp(e);
  surface.addEventListener("pointerdown", down);
  surface.addEventListener("pointermove", move);
  surface.addEventListener("pointerup", up);
  surface.addEventListener("pointercancel", up);

  return () => {
    surface.removeEventListener("pointerdown", down);
    surface.removeEventListener("pointermove", move);
    surface.removeEventListener("pointerup", up);
    surface.removeEventListener("pointercancel", up);
  };
}

/** Floor so a measurement glitch (e.g. a mid-layout read) can never shrink the
 * window to 0x0 and make it unrecoverable without a restart. */
const MIN_WIDTH_CSS = 40;
const MIN_HEIGHT_CSS = 24;

/**
 * Resize the native overlay window to hug the panel's rendered box, so the
 * transparent window is never bigger than it needs to be (an oversized
 * transparent window still eats clicks meant for whatever's behind it). Width
 * and height both track content — a lone dial and a five-account row each get
 * exactly the size they render at.
 *
 * The panel sits at the window's top-left origin and its padding is sized so
 * the hover info circle always fits inside its border box (see overlay.css) —
 * so a plain setSize to the panel's width/height covers everything and the
 * window never has to move or grow on hover (which is what used to make it
 * stutter and wander). Called only on (re)render, not on hover. Safe no-op
 * outside Tauri.
 */
export async function resizeOverlayToContent(contentEl: HTMLElement): Promise<void> {
  const wapi = tauriWindow();
  if (!wapi) return;
  const rect = contentEl.getBoundingClientRect();
  const w = Math.max(MIN_WIDTH_CSS, Math.ceil(rect.right));
  const h = Math.max(MIN_HEIGHT_CSS, Math.ceil(rect.bottom));
  try {
    await wapi.getCurrentWindow().setSize(new wapi.LogicalSize(w, h));
  } catch (err) {
    console.error("overlay: resize-to-content failed", err);
  }
}
