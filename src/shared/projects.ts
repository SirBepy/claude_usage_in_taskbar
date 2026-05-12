/**
 * Project-path helpers.
 * Ported from src/dashboard.js (renderAvatar, basenameProj)
 * and src/modules/stats.js (projectLabel, isSubagentCwd, isBlacklisted).
 */

import type { AliasMap } from "./tokens";
import { resolveMergeChain } from "./merges";
import { api } from "./api";
import { escapeHtml } from "./escape-html";

export interface Avatar {
  kind?: "emoji" | "image" | "none" | "character";
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

export function renderAvatar(avatar: Avatar | undefined | null): string {
  if (!avatar || avatar.kind === "none") return "?";
  if (avatar.kind === "emoji") return escapeHtml(avatar.value ?? "");
  if (avatar.kind === "image") {
    const src = `file:///${String(avatar.value).replaceAll("\\", "/")}`;
    return `<img src="${src}" style="width:100%;height:100%;object-fit:cover;border-radius:7px" alt="">`;
  }
  if (avatar.kind === "character") {
    const id = escapeHtml(avatar.value ?? "");
    return `<img class="char-avatar" data-character-id="${id}" alt="${id}" style="width:100%;height:100%;object-fit:cover;border-radius:7px;image-rendering:pixelated">`;
  }
  return "?";
}

/**
 * Resolves data URLs for any rendered character avatars within `root`.
 * Call after `renderAvatar` output is in the DOM. Idempotent: skips imgs
 * that already have a `src`.
 */
export async function hydrateCharacterAvatars(root: HTMLElement | Document = document): Promise<void> {
  const imgs = root.querySelectorAll<HTMLImageElement>("img.char-avatar[data-character-id]");
  for (const img of Array.from(imgs)) {
    if (img.src) continue;
    const id = img.dataset.characterId;
    if (!id) continue;
    try {
      const url = await api.characterAssetUrl(id, "icon.png");
      if (url) img.src = url;
    } catch (e) {
      console.warn("[avatar] failed to load character icon", id, e);
    }
  }
}
