export interface Preset {
  name: string;
  model: string;
  effort: string;
}

export interface SessionConfig {
  model: string;
  effort: string;
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
      const model = isModel(o.model) ? o.model : "";
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
  const model = typeof e.model === "string" ? e.model : "";
  const effort = typeof e.effort === "string" ? e.effort : "";
  if (isModel(model) && isEffort(effort)) return { model, effort };
  return null;
}
