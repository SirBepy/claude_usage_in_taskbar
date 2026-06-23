// Phone-side Web Push enrolment (ai_todo 119). The daemon sends a push when a
// chat becomes blocked on a prompt and the PC is idle; this module subscribes
// the phone's browser to that channel and registers the subscription with the
// daemon.
//
// These hit the daemon's REST push endpoints directly with the bearer token
// (NOT /api/rpc, so they bypass the HttpTransport command table). Desktop never
// calls these - push is a phone-only feature gated by isRemote() at the call
// site.

import { remoteToken } from "./transport";

/** localStorage flag mirroring "the user turned push on" so the toggle reflects
 *  reality across reloads without re-querying permission state. */
const PUSH_ENABLED_KEY = "rc_push_enabled";

export type EnableResult =
  | { ok: true }
  | { ok: false; reason: "unsupported" | "denied" | "error" };

/** True if the browser can do Web Push at all (Service Worker + Push +
 *  Notification). iOS Safari only exposes these in an installed PWA; Android
 *  Chrome always has them. */
export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** The user's last explicit choice, persisted. The actual source of truth is
 *  the live PushManager subscription; this is just the UI hint. */
export function pushEnabledLocally(): boolean {
  try {
    return localStorage.getItem(PUSH_ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

function setPushEnabledLocally(on: boolean): void {
  try {
    if (on) localStorage.setItem(PUSH_ENABLED_KEY, "1");
    else localStorage.removeItem(PUSH_ENABLED_KEY);
  } catch {
    /* storage unavailable - the toggle just won't persist */
  }
}

/** VAPID public keys arrive as base64url (unpadded); the Push API wants the raw
 *  bytes as a Uint8Array applicationServerKey. Exported for tests. */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${remoteToken()}`,
    "Content-Type": "application/json",
  };
}

/** Enrol this browser: ask permission, subscribe via the daemon's VAPID key,
 *  and register the subscription with the daemon. Idempotent - re-running it
 *  reuses an existing subscription. */
export async function enablePush(): Promise<EnableResult> {
  if (!pushSupported()) return { ok: false, reason: "unsupported" };
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return { ok: false, reason: "denied" };

    const reg = await navigator.serviceWorker.ready;

    // Reuse an existing subscription if the browser already has one (avoids a
    // pointless re-subscribe and key mismatch); else create one with our key.
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const res = await fetch("/api/push/vapid-public-key", { headers: authHeaders() });
      if (!res.ok) return { ok: false, reason: "error" };
      const { key } = (await res.json()) as { key: string };
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        // Cast: the DOM lib types applicationServerKey as BufferSource; a
        // Uint8Array satisfies it at runtime but the generic ArrayBufferLike
        // param trips the checker.
        applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
      });
    }

    const reg2 = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(sub.toJSON()),
    });
    if (!reg2.ok) return { ok: false, reason: "error" };

    setPushEnabledLocally(true);
    return { ok: true };
  } catch (e) {
    console.error("[push] enable failed", e);
    return { ok: false, reason: "error" };
  }
}

/** Unenrol this browser: tell the daemon to drop the subscription and cancel it
 *  locally. */
export async function disablePush(): Promise<void> {
  setPushEnabledLocally(false);
  try {
    if (!pushSupported()) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    await fetch("/api/push/unsubscribe", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ endpoint }),
    }).catch(() => {});
    await sub.unsubscribe().catch(() => false);
  } catch (e) {
    console.error("[push] disable failed", e);
  }
}
