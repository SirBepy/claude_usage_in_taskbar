import type { SlashEntry, SlashSource } from "../../../types/ipc.generated";
import { fuzzyScore } from "./fuzzy-score";

const MAX = 50;

const SRC_RANK: Record<string, number> = {
  "project-command": 0,
  "user-command": 1,
  "user-skill": 2,
  "plugin-skill": 3,
  "plugin-command": 4,
  builtin: 5,
};

function srcRank(s: SlashSource): number {
  const k = (s as { kind: string }).kind;
  return SRC_RANK[k] ?? 99;
}

interface Scored {
  it: SlashEntry;
  score: number;
  prefix: boolean;
}

export function match(items: SlashEntry[], q: string): SlashEntry[] {
  if (!q) return items.slice(0, MAX);
  const ql = q.toLowerCase();
  const scored: Scored[] = [];
  for (const it of items) {
    const nl = it.name.toLowerCase();
    if (nl.startsWith(ql)) {
      scored.push({ it, score: 100_000 - it.name.length, prefix: true });
    } else {
      const s = fuzzyScore(nl, ql);
      if (s > 0) scored.push({ it, score: s, prefix: false });
    }
  }
  scored.sort((a, b) => {
    if (a.prefix !== b.prefix) return a.prefix ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    const r = srcRank(a.it.source) - srcRank(b.it.source);
    if (r !== 0) return r;
    return a.it.name.length - b.it.name.length;
  });
  return scored.slice(0, MAX).map((x) => x.it);
}
