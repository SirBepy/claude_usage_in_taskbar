// Global rate-limit banner.
//
// When claude -p reports a `rate_limit_event` with status "rejected" the turn
// was actually blocked (account-wide: every session is throttled until the
// window resets). The Rust parser surfaces ONLY rejections (warnings are
// suppressed) as a `Notification { kind: "rate_limit", body }`. The event-store
// routes those here instead of into a transcript row.
//
// This controller owns ONE app-wide banner at the top of the Chats window:
//   - names the limit that fired (5-hour vs weekly),
//   - shows the exact reset time and a live countdown beneath it,
//   - offers "Auto continue on reset" (default on): when the window resets it
//     sends "continue" to every chat that was interrupted.
//
// The core is dependency-injected (now/sendContinue) so it is unit-testable
// without Tauri or real timers.

interface BannerDeps {
  /** Current time in ms. Injectable for tests. */
  now?: () => number;
  /** Sends a "continue" turn to one interrupted session. Wired to IPC at mount. */
  sendContinue?: (sessionId: string) => void;
}

/** Human label for a rateLimitType value from the stream payload. */
function humanType(rateLimitType: string): string {
  switch (rateLimitType) {
    case "five_hour":
      return "5-hour limit";
    case "seven_day":
    case "weekly":
      return "Weekly limit";
    default:
      return rateLimitType ? `${rateLimitType.replace(/_/g, " ")} limit` : "Usage limit";
  }
}

/** Format an absolute reset time. Includes the date only when it isn't today. */
function formatResetTime(resetsAtMs: number, nowMs: number): string {
  const d = new Date(resetsAtMs);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = new Date(nowMs).toDateString() === d.toDateString();
  return sameDay ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

/** Format a remaining duration (ms) as "1h 04m 30s" / "4m 30s" / "30s". */
function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export class RateLimitBanner {
  private host: HTMLElement | null = null;
  private interrupted = new Set<string>();
  private resetsAt = 0; // unix SECONDS (0 = inactive)
  private rateLimitType = "";
  private autoContinue = true;
  private timer: ReturnType<typeof setInterval> | null = null;
  private countdownEl: HTMLElement | null = null;
  private now: () => number;
  private sendContinue: (sessionId: string) => void;

  constructor(deps?: BannerDeps) {
    this.now = deps?.now ?? (() => Date.now());
    this.sendContinue = deps?.sendContinue ?? (() => {});
  }

  /** Attach to the host element and paint the current state. */
  mount(host: HTMLElement): void {
    this.host = host;
    this.render();
  }

  setSendContinue(fn: (sessionId: string) => void): void {
    this.sendContinue = fn;
  }

  /** Inspectable snapshot for tests. */
  get state(): { interrupted: string[]; resetsAt: number; autoContinue: boolean; active: boolean } {
    return {
      interrupted: [...this.interrupted],
      resetsAt: this.resetsAt,
      autoContinue: this.autoContinue,
      active: this.resetsAt > 0,
    };
  }

  /** Live set of session IDs whose last turn was blocked by a rate-limit rejection. */
  get interruptedSet(): ReadonlySet<string> {
    return this.interrupted;
  }

  /** Record a rate-limit rejection for one session. Body is the raw JSON string. */
  report(sessionId: string, body: string): void {
    let info: { status?: string; rateLimitType?: string; resetsAt?: number } | null = null;
    try {
      info = JSON.parse(body);
    } catch {
      return;
    }
    if (!info || info.status !== "rejected") return;
    const resetsAt = Number(info.resetsAt) || 0;
    if (!resetsAt) return;

    this.interrupted.add(sessionId);
    // Account-wide window: all rejections share a resetsAt; keep the latest.
    this.resetsAt = Math.max(this.resetsAt, resetsAt);
    if (info.rateLimitType) this.rateLimitType = String(info.rateLimitType);

    if (!this.timer) this.timer = setInterval(() => this.tick(), 1000);
    this.render();
  }

  /** One countdown step. Public so tests can drive it with an injected clock. */
  tick(): void {
    if (this.resetsAt <= 0) return;
    if (this.now() >= this.resetsAt * 1000) {
      this.onReset();
      return;
    }
    this.renderCountdown();
  }

  private onReset(): void {
    const sessions = [...this.interrupted];
    const auto = this.autoContinue;
    this.clear();
    if (auto) for (const id of sessions) this.sendContinue(id);
  }

  /** Tear down the banner and stop the timer. */
  clear(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.interrupted.clear();
    this.resetsAt = 0;
    this.rateLimitType = "";
    this.countdownEl = null;
    this.render();
  }

  private render(): void {
    if (!this.host) return;
    if (this.resetsAt <= 0) {
      this.host.innerHTML = "";
      this.host.hidden = true;
      this.countdownEl = null;
      return;
    }
    this.host.hidden = false;
    const resetsAtMs = this.resetsAt * 1000;
    const title = `${humanType(this.rateLimitType)} reached`;
    const exact = formatResetTime(resetsAtMs, this.now());

    this.host.innerHTML = `
      <div class="rate-limit-banner">
        <i class="ph ph-hourglass-high rlb-icon"></i>
        <div class="rlb-text">
          <div class="rlb-title">${title}</div>
          <div class="rlb-time">Resets ${exact}</div>
          <div class="rlb-countdown"></div>
        </div>
        <label class="rlb-auto">
          <input type="checkbox" class="rlb-auto-cb" ${this.autoContinue ? "checked" : ""} />
          <span>Auto continue on reset</span>
        </label>
      </div>`;

    this.countdownEl = this.host.querySelector<HTMLElement>(".rlb-countdown");
    const cb = this.host.querySelector<HTMLInputElement>(".rlb-auto-cb");
    cb?.addEventListener("change", () => {
      this.autoContinue = !!cb.checked;
    });
    this.renderCountdown();
  }

  private renderCountdown(): void {
    if (!this.countdownEl || this.resetsAt <= 0) return;
    const remaining = this.resetsAt * 1000 - this.now();
    this.countdownEl.textContent = `${formatRemaining(remaining)} remaining`;
  }
}

/** App-wide singleton. */
export const rateLimitBanner = new RateLimitBanner();
