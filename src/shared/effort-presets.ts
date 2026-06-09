export interface Preset {
  name: string;
  model: string;
  effort: string;
}

export interface SessionConfig {
  model: string;
  effort: string;
  // Auto-allow tool permission prompts for this session. Defaults on for new
  // chats (the modal checkbox); undefined on legacy drafts is treated as on.
  autoAccept?: boolean;
  // Spawn `claude --remote-control` for this session. Defaults on for new chats
  // (the modal checkbox); undefined on legacy drafts is treated as on.
  remote?: boolean;
}

export const MODELS = ["haiku", "sonnet", "opus"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export const DEFAULT_PRESETS: Preset[] = [
  { name: "Light", model: "sonnet", effort: "low" },
  { name: "Normal", model: "opus", effort: "high" },
  { name: "Heavy", model: "opus", effort: "max" },
];

export function isModel(v: unknown): v is typeof MODELS[number] {
  return typeof v === "string" && (MODELS as readonly string[]).includes(v);
}

export function isEffort(v: unknown): v is typeof EFFORTS[number] {
  return typeof v === "string" && (EFFORTS as readonly string[]).includes(v);
}

/**
 * Models offered in the "New session" picker. Reads `settings.models` when it is
 * a non-empty array of non-empty strings (trimmed + deduped, order preserved),
 * otherwise falls back to the built-in `MODELS` seed.
 */
export function readModels(settings: Record<string, unknown>): string[] {
  const raw = settings["models"];
  if (Array.isArray(raw)) {
    const out: string[] = [];
    for (const m of raw) {
      if (typeof m === "string") {
        const t = m.trim();
        if (t && !out.includes(t)) out.push(t);
      }
    }
    if (out.length > 0) return out;
  }
  return [...MODELS];
}

/**
 * Default checkbox states for the "New session" modal. Both default ON when the
 * setting is absent; only an explicit `false` flips them off.
 */
export function readDefaultFlags(
  settings: Record<string, unknown>,
): { autoAccept: boolean; remote: boolean } {
  return {
    autoAccept: settings["defaultAutoAllow"] !== false,
    remote: settings["defaultRemoteControl"] !== false,
  };
}

export function readPresets(
  settings: Record<string, unknown>,
  opts?: { padWithDefaults?: boolean },
): Preset[] {
  const raw = settings["effortPresets"];
  if (!Array.isArray(raw)) return opts?.padWithDefaults ? [...DEFAULT_PRESETS] : DEFAULT_PRESETS;
  const out: Preset[] = [];
  for (const p of raw) {
    if (p && typeof p === "object") {
      const o = p as Record<string, unknown>;
      const name = typeof o.name === "string" ? o.name : "";
      // Loosened: accept any non-empty model string so user-defined models in
      // settings.models survive. Effort stays strict (isEffort).
      const model = typeof o.model === "string" ? o.model.trim() : "";
      const effort = isEffort(o.effort) ? o.effort : "";
      if (name && model && effort) out.push({ name, model, effort });
    }
  }
  if (opts?.padWithDefaults) {
    while (out.length < 3) {
      const d = DEFAULT_PRESETS[out.length]!;
      out.push({ ...d });
    }
    return out.slice(0, 3);
  }
  return out.length === 3 ? out : DEFAULT_PRESETS;
}

export function readLastChoice(
  settings: Record<string, unknown>,
  projectPath: string,
): SessionConfig | null {
  const map = settings["projectLastChoice"];
  if (!map || typeof map !== "object") return null;
  const entry = (map as Record<string, unknown>)[projectPath];
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  const model = typeof e.model === "string" ? e.model.trim() : "";
  const effort = typeof e.effort === "string" ? e.effort : "";
  // Loosened: any non-empty model string is accepted (user-defined models).
  // Effort stays strict.
  if (model && isEffort(effort)) return { model, effort };
  return null;
}
