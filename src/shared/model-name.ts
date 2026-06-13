/** "claude-opus-4-8" -> "opus" (bare family, lowercase). Used where space is tight. */
export function modelFamily(model: string): string {
  const s = model.toLowerCase();
  if (s.includes("opus")) return "opus";
  if (s.includes("sonnet")) return "sonnet";
  if (s.includes("haiku")) return "haiku";
  if (s.includes("fable")) return "fable";
  return model;
}

/** "claude-opus-4-8" -> "Opus 4.8" (capitalized, version dotted). Used in the
 *  statusbar chips and the new-session model picker. Strips the "claude-"
 *  prefix, any trailing date stamp ("-20251001") or "[1m]" context suffix,
 *  turns the family/version split into a space and the remaining version
 *  hyphens into dots. Result matches the API's display_name minus the brand
 *  prefix (e.g. "Claude Opus 4.8" -> "Opus 4.8"). */
export function modelLabel(model: string): string {
  let m = model
    .replace(/^claude-/, "")
    .replace(/\[[^\]]*\]$/, "") // drop a "[1m]" context-window suffix
    .replace(/-\d{6,}$/, ""); // drop a trailing date stamp like "-20251001"
  m = m.replace(/-(?=\d)/, " "); // family/version boundary -> space (first only)
  m = m.replace(/-/g, "."); // remaining version hyphens -> dots
  return m.charAt(0).toUpperCase() + m.slice(1);
}
