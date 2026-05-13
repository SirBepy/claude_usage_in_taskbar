import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import type { SessionMeta } from "../../shared/chat/chat-renderer";
import type { GitInfo } from "../../types/ipc.generated";

// ── Statusline helpers ────────────────────────────────────────────────────────

export const DEFAULT_STATUSLINE_FIELDS = ["model", "effort", "branch", "repo", "context", "thinking"];

export const ALL_STATUSLINE_FIELDS = [
  { key: "branch",   label: "Branch" },
  { key: "repo",     label: "Repo" },
  { key: "folder",   label: "Project Folder" },
  { key: "model",    label: "Model" },
  { key: "effort",   label: "Effort" },
  { key: "context",  label: "Context %" },
  { key: "thinking", label: "Thinking" },
  { key: "duration", label: "Duration" },
];

const VALID_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export async function loadStatuslineFields(): Promise<string[]> {
  try {
    const s = await invoke<Record<string, unknown>>("get_settings");
    const v = s["statuslineFields"];
    if (Array.isArray(v)) return v as string[];
  } catch { /* ignore */ }
  return [...DEFAULT_STATUSLINE_FIELDS];
}

export async function saveStatuslineFields(fields: string[]): Promise<void> {
  try {
    const s = await invoke<Record<string, unknown>>("get_settings");
    await invoke("save_settings", { updated: { ...s, statuslineFields: fields } });
  } catch (e) {
    console.error("[statusbar] save fields failed", e);
  }
}

export function modelContextWindow(model: string | null): number {
  // Opus 4.7 has a 1M token context window; all other current models use 200K.
  // Claude Code does not emit context_window in the stream-json init line,
  // so we derive it from the model name.
  if (model && model.includes("opus-4-7")) return 1_000_000;
  return 200_000;
}

export function shortModelName(model: string): string {
  // "claude-opus-4-7" -> "Opus 4.7", "claude-sonnet-4-6" -> "Sonnet 4.6"
  const m = model.replace(/^claude-/, "").replace(/-(\d)/, " $1");
  return m.charAt(0).toUpperCase() + m.slice(1);
}

export function formatDuration(startedAt: string): string {
  const ms = Math.max(0, Date.now() - new Date(startedAt).getTime());
  const totalSecs = Math.floor(ms / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ── SessionStatusbar ─────────────────────────────────────────────────────────

export interface StatusbarOptions {
  cwd?: string | null;
  effort?: string;
  sessionId?: string | null;
  readOnly?: boolean;
}

export class SessionStatusbar {
  private container: HTMLElement;
  private fields: string[];
  private meta: SessionMeta = { model: null, inputTokens: 0, hasThinking: false, totalCostUsd: 0, hasUsage: false };
  private gitInfo: GitInfo = { branch: null, repo: null };
  private startedAt: string | null;
  private cwd: string | null;
  private effort: string;
  private sessionId: string | null;
  private readOnlyEffort: boolean;
  private durationTimer: ReturnType<typeof setInterval> | null = null;
  private popoverOpen = false;
  private effortPopoverOpen = false;
  private modelPopoverOpen = false;

  constructor(container: HTMLElement, startedAt: string | null, fields: string[], opts: StatusbarOptions = {}) {
    this.container = container;
    this.startedAt = startedAt;
    this.fields = fields;
    this.cwd = opts.cwd ?? null;
    this.effort = opts.effort ?? "";
    this.sessionId = opts.sessionId ?? null;
    this.readOnlyEffort = opts.readOnly ?? false;
    this.container.className = "session-statusbar";
    this.render();
    if (this.fields.includes("duration")) this.startDurationTimer();
  }

  updateMeta(meta: SessionMeta): void {
    this.meta = meta;
    this.render();
  }

  updateGitInfo(info: GitInfo): void {
    this.gitInfo = info;
    this.render();
  }

  setSessionId(id: string): void {
    this.sessionId = id;
  }

  setReadOnlyEffort(readOnly: boolean): void {
    if (this.readOnlyEffort === readOnly) return;
    this.readOnlyEffort = readOnly;
    this.render();
  }

  destroy(): void {
    if (this.durationTimer) { clearInterval(this.durationTimer); this.durationTimer = null; }
  }

  private startDurationTimer(): void {
    this.durationTimer = setInterval(() => this.render(), 1000);
  }

  private render(): void {
    const f = this.fields;

    // Git group: branch, repo, folder
    const gitChips: string[] = [];
    if (f.includes("branch") && this.gitInfo.branch) {
      gitChips.push(`<span class="sb-chip sb-branch"><i class="ph ph-git-branch"></i>${escapeHtml(this.gitInfo.branch)}</span>`);
    }
    if (f.includes("repo") && this.gitInfo.repo) {
      gitChips.push(`<span class="sb-chip sb-repo"><i class="ph ph-folder-simple"></i>${escapeHtml(this.gitInfo.repo)}</span>`);
    }
    if (f.includes("folder") && this.cwd) {
      const folderName = this.cwd.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? this.cwd;
      const cwdEsc = escapeHtml(this.cwd);
      gitChips.push(`<span class="sb-chip sb-folder sb-folder-btn" role="button" title="${cwdEsc}" data-cwd="${cwdEsc}"><i class="ph ph-folder-open"></i>${escapeHtml(folderName)}</span>`);
    }

    // Claude group: model, effort, context, thinking, duration, cost
    const claudeChips: string[] = [];
    if (f.includes("model") && this.meta.model) {
      claudeChips.push(`<span class="sb-chip sb-model sb-model-btn" role="button" tabindex="0"><i class="ph ph-robot"></i>${escapeHtml(shortModelName(this.meta.model))}</span>`);
    }
    if (f.includes("effort") && this.effort) {
      const cls = this.readOnlyEffort ? " readonly" : " sb-effort-btn";
      claudeChips.push(`<span class="sb-chip sb-effort${cls}" role="button" tabindex="0"><i class="ph ph-gauge"></i>${escapeHtml(this.effort)}</span>`);
    }
    if (f.includes("context") && this.meta.inputTokens > 0) {
      const window = modelContextWindow(this.meta.model);
      const raw = (this.meta.inputTokens / window) * 100;
      const pctStr = raw < 1 ? "<1" : String(Math.min(100, Math.round(raw)));
      const cls = raw >= 80 ? " danger" : raw >= 50 ? " warn" : "";
      claudeChips.push(`<span class="sb-chip sb-context${cls}" title="${this.meta.inputTokens.toLocaleString()} / ${window.toLocaleString()} tokens"><i class="ph ph-stack"></i>${pctStr}%</span>`);
    }
    if (f.includes("thinking") && this.meta.hasThinking) {
      claudeChips.push(`<span class="sb-chip sb-thinking active"><i class="ph ph-brain"></i>thinking</span>`);
    }
    if (f.includes("duration") && this.startedAt) {
      claudeChips.push(`<span class="sb-chip sb-duration"><i class="ph ph-timer"></i>${formatDuration(this.startedAt)}</span>`);
    }

    const sep = gitChips.length > 0 && claudeChips.length > 0
      ? `<span class="sb-sep"></span>`
      : "";
    const allChips = [...gitChips, ...(sep ? [sep] : []), ...claudeChips];

    const popoverHtml = this.popoverOpen ? `
      <div class="sb-popover">
        ${ALL_STATUSLINE_FIELDS.map(({ key, label }) => `
          <label class="sb-popover-row">
            <input type="checkbox" data-key="${key}"${f.includes(key) ? " checked" : ""}>
            ${escapeHtml(label)}
          </label>
        `).join("")}
      </div>
    ` : "";

    const effortIdx = Math.max(0, VALID_EFFORTS.indexOf(this.effort as typeof VALID_EFFORTS[number]));
    const effortPopoverHtml = this.effortPopoverOpen ? `
      <div class="sb-effort-popover">
        <div class="sb-effort-popover-label">Effort</div>
        <input type="range" class="sb-effort-slider" min="0" max="${VALID_EFFORTS.length - 1}" step="1" value="${effortIdx}">
        <div class="sb-effort-stops">
          ${VALID_EFFORTS.map((e, i) => `<span class="sb-effort-stop${i === effortIdx ? " active" : ""}">${escapeHtml(e)}</span>`).join("")}
        </div>
      </div>
    ` : "";

    const modelPopoverHtml = this.modelPopoverOpen && this.meta.model ? `
      <div class="sb-model-popover">
        <div class="sb-model-popover-name">${escapeHtml(this.meta.model)}</div>
        <div class="sb-model-popover-hint">Locked for this session. Start a new session to change.</div>
      </div>
    ` : "";

    this.container.innerHTML = `
      <div class="sb-chips">${allChips.length > 0 ? allChips.join("") : '<span class="sb-empty">No fields</span>'}</div>
      <button class="sb-gear icon-btn" title="Configure statusline"><i class="ph ph-sliders-horizontal"></i></button>
      ${popoverHtml}
      ${effortPopoverHtml}
      ${modelPopoverHtml}
    `;

    this.container.querySelector(".sb-gear")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.popoverOpen = !this.popoverOpen;
      this.render();
    });

    this.container.querySelector<HTMLElement>(".sb-folder-btn")?.addEventListener("click", () => {
      if (this.cwd) {
        void invoke<void>("open_in_explorer", { path: this.cwd });
      }
    });

    this.container.querySelector<HTMLElement>(".sb-model-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.modelPopoverOpen = !this.modelPopoverOpen;
      this.effortPopoverOpen = false;
      this.render();
    });

    this.container.querySelector<HTMLElement>(".sb-effort-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.readOnlyEffort) return;
      this.effortPopoverOpen = !this.effortPopoverOpen;
      this.modelPopoverOpen = false;
      this.render();
    });

    if (this.effortPopoverOpen) {
      const slider = this.container.querySelector<HTMLInputElement>(".sb-effort-slider");
      slider?.addEventListener("change", () => {
        const i = Number(slider.value);
        const next = VALID_EFFORTS[i];
        if (!next || !this.sessionId) return;
        const sid = this.sessionId;
        const newEffort = next;
        void invoke<void>("set_session_effort", { sessionId: sid, effort: newEffort })
          .then(() => {
            this.effort = newEffort;
            this.effortPopoverOpen = false;
            this.render();
          })
          .catch((err) => {
            console.error("[statusbar] set_session_effort failed", err);
          });
      });
      const closeOnOutsideEffort = (e: MouseEvent) => {
        if (!this.container.contains(e.target as Node)) {
          this.effortPopoverOpen = false;
          this.render();
          document.removeEventListener("click", closeOnOutsideEffort);
        }
      };
      setTimeout(() => document.addEventListener("click", closeOnOutsideEffort), 0);
    }

    if (this.modelPopoverOpen) {
      const closeOnOutsideModel = (e: MouseEvent) => {
        if (!this.container.contains(e.target as Node)) {
          this.modelPopoverOpen = false;
          this.render();
          document.removeEventListener("click", closeOnOutsideModel);
        }
      };
      setTimeout(() => document.addEventListener("click", closeOnOutsideModel), 0);
    }

    if (this.popoverOpen) {
      this.container.querySelectorAll<HTMLInputElement>(".sb-popover input").forEach((cb) => {
        cb.addEventListener("change", () => {
          const key = cb.dataset.key!;
          if (cb.checked) {
            if (!this.fields.includes(key)) this.fields = [...this.fields, key];
          } else {
            this.fields = this.fields.filter((k) => k !== key);
          }
          void saveStatuslineFields(this.fields);
          if (key === "duration") {
            if (this.fields.includes("duration") && !this.durationTimer) {
              this.startDurationTimer();
            } else if (!this.fields.includes("duration") && this.durationTimer) {
              clearInterval(this.durationTimer);
              this.durationTimer = null;
            }
          }
          this.render();
        });
      });

      const closeOnOutside = (e: MouseEvent) => {
        if (!this.container.contains(e.target as Node)) {
          this.popoverOpen = false;
          this.render();
          document.removeEventListener("click", closeOnOutside);
        }
      };
      setTimeout(() => document.addEventListener("click", closeOnOutside), 0);
    }
  }
}
