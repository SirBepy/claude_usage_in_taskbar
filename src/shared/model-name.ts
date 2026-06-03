/** "claude-opus-4-8" -> "opus" (bare family, lowercase). Used where space is tight. */
export function modelFamily(model: string): string {
  const s = model.toLowerCase();
  if (s.includes("opus")) return "opus";
  if (s.includes("sonnet")) return "sonnet";
  if (s.includes("haiku")) return "haiku";
  return model;
}

/** "claude-opus-4-7" -> "Opus 4.7" (capitalized with version). Used in statusbar chips. */
export function modelLabel(model: string): string {
  const m = model.replace(/^claude-/, "").replace(/-(\d)/, " $1");
  return m.charAt(0).toUpperCase() + m.slice(1);
}
