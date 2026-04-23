/**
 * Merge alias chain helpers.
 * Ported from src/modules/stats.js (resolveMergeChain, doMerge, doRepoint, doUnmerge).
 * Mutation helpers operate on a caller-owned aliases map; callers must persist
 * settings themselves (typically via the state module's saveSettings).
 */

import type { AliasMap } from "./tokens";

export function resolveMergeChain(cwd: string, aliases: AliasMap): string {
  let cur = cwd;
  const seen = new Set<string>();
  while (aliases[cur]?.mergedInto && !seen.has(cur)) {
    seen.add(cur);
    cur = aliases[cur]!.mergedInto!;
  }
  return cur;
}

export function doMerge(aliases: AliasMap, fromCwd: string, intoCwd: string): void {
  const inheritedPaths = aliases[fromCwd]?.mergedPaths || [];
  aliases[fromCwd] = { mergedInto: intoCwd };
  if (!aliases[intoCwd]) aliases[intoCwd] = {};
  const into = aliases[intoCwd]!;
  if (!into.mergedPaths) into.mergedPaths = [];
  if (!into.mergedPaths.includes(fromCwd)) into.mergedPaths.push(fromCwd);
  for (const p of inheritedPaths) {
    if (!into.mergedPaths.includes(p)) into.mergedPaths.push(p);
    if (aliases[p]) aliases[p]!.mergedInto = intoCwd;
  }
}

export function doRepoint(aliases: AliasMap, oldCwd: string, newCwd: string): void {
  const oldName = aliases[oldCwd]?.name;
  const inheritedPaths = aliases[oldCwd]?.mergedPaths || [];
  aliases[oldCwd] = { mergedInto: newCwd };
  if (!aliases[newCwd]) aliases[newCwd] = {};
  const next = aliases[newCwd]!;
  if (oldName && !next.name) next.name = oldName;
  if (!next.mergedPaths) next.mergedPaths = [];
  if (!next.mergedPaths.includes(oldCwd)) next.mergedPaths.push(oldCwd);
  for (const p of inheritedPaths) {
    if (!next.mergedPaths.includes(p)) next.mergedPaths.push(p);
    if (aliases[p]) aliases[p]!.mergedInto = newCwd;
  }
}

export function doUnmerge(aliases: AliasMap, secondaryCwd: string, primaryCwd: string): void {
  if (!aliases) return;
  delete aliases[secondaryCwd];
  const primary = aliases[primaryCwd];
  if (primary?.mergedPaths) {
    primary.mergedPaths = primary.mergedPaths.filter((p) => p !== secondaryCwd);
    if (!primary.mergedPaths.length) delete primary.mergedPaths;
  }
}
