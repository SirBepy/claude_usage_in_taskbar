// Push-to-talk binding: a user-chosen key or mouse side-button that records
// voice while held. Desktop-only - the phone view dictates via the on-screen
// mic. Persisted in localStorage because the chosen shortcut must survive app
// restarts (mirrors the mic-device persistence in voice-devices.ts).

const PTT_KEY = "voice_ptt_binding";

export type PttBinding =
  | { kind: "key"; code: string; label: string }
  | { kind: "mouse"; button: number; label: string };

export function getPttBinding(): PttBinding | null {
  try {
    const raw = localStorage.getItem(PTT_KEY);
    if (!raw) return null;
    const b = JSON.parse(raw) as PttBinding;
    if (b && (b.kind === "key" || b.kind === "mouse")) return b;
    return null;
  } catch {
    return null;
  }
}

export function setPttBinding(b: PttBinding | null): void {
  try {
    if (b) localStorage.setItem(PTT_KEY, JSON.stringify(b));
    else localStorage.removeItem(PTT_KEY);
  } catch {
    /* storage unavailable */
  }
}

// MouseEvent.button: 0 left, 1 middle, 2 right, 3 back (X1), 4 forward (X2).
const MOUSE_LABELS: Record<number, string> = {
  1: "Middle click",
  3: "Mouse back (X1)",
  4: "Mouse forward (X2)",
};

export function mouseButtonLabel(button: number): string {
  return MOUSE_LABELS[button] ?? `Mouse button ${button + 1}`;
}

/** Friendly label for a physical KeyboardEvent.code (no modifiers - PTT is a
 *  single held button, not a chord). */
export function keyCodeLabel(code: string): string {
  const map: Record<string, string> = {
    Space: "Space",
    Enter: "Enter",
    Tab: "Tab",
    Backquote: "` (backtick)",
    ControlLeft: "Left Ctrl",
    ControlRight: "Right Ctrl",
    AltLeft: "Left Alt",
    AltRight: "Right Alt",
    ShiftLeft: "Left Shift",
    ShiftRight: "Right Shift",
    MetaLeft: "Left Meta",
    MetaRight: "Right Meta",
    CapsLock: "Caps Lock",
  };
  if (map[code]) return map[code];
  return code.replace(/^(Key|Digit)/, "");
}

export function formatPttBinding(b: PttBinding | null): string {
  return b ? b.label : "Not set";
}

export function keyMatches(b: PttBinding | null, e: KeyboardEvent): boolean {
  return !!b && b.kind === "key" && b.code === e.code;
}

export function mouseMatches(b: PttBinding | null, e: MouseEvent): boolean {
  return !!b && b.kind === "mouse" && b.button === e.button;
}
