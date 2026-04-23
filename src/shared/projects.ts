/**
 * Project-path helpers.
 * Ported from src/dashboard.js (renderAvatar, basenameProj, escapeProjHtml)
 * and src/modules/stats.js (projectLabel, isSubagentCwd, isBlacklisted).
 */

import type { AliasMap } from "./tokens";
import { resolveMergeChain } from "./merges";

export interface Avatar {
  kind?: "emoji" | "image" | "none";
  value?: string;
}

export function basenameProj(p: string | null | undefined): string {
  if (!p) return "(unknown)";
  const parts = String(p).split(/[\\/]/);
  return parts.filter(Boolean).pop() || "(unknown)";
}

export function isSubagentCwd(cwd: string | null | undefined): boolean {
  return !!cwd && /[/\\]\.claude[/\\]subagents[/\\]/i.test(cwd);
}

export function isBlacklisted(
  cwd: string,
  aliases: AliasMap,
  blacklist: string[] | null | undefined,
): boolean {
  if (!blacklist || !blacklist.length) return false;
  return blacklist.includes(resolveMergeChain(cwd, aliases));
}

export function projectLabel(cwd: string, aliases: AliasMap): string {
  const alias = aliases[cwd];
  const fallback = cwd ? cwd.split(/[/\\]/).filter(Boolean).pop() || cwd : "(unknown)";
  if (!alias) return fallback;
  const name = alias.name || fallback;
  const emoji = alias.emoji || "";
  return emoji && !name.startsWith(emoji) ? `${emoji} ${name}` : name;
}

export function escapeProjHtml(s: string | null | undefined): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return c;
    }
  });
}

export function renderAvatar(avatar: Avatar | undefined | null): string {
  if (!avatar || avatar.kind === "none") return "?";
  if (avatar.kind === "emoji") return escapeProjHtml(avatar.value);
  if (avatar.kind === "image") {
    const src = `file:///${String(avatar.value).replaceAll("\\", "/")}`;
    return `<img src="${src}" style="width:100%;height:100%;object-fit:cover;border-radius:7px" alt="">`;
  }
  return "?";
}
