import { fuzzyScore } from "./fuzzy-score";

const MAX = 50;

interface Scored {
  p: string;
  score: number;
  tier: number;
}

export function matchFiles(paths: string[], q: string): string[] {
  if (!q) return paths.slice(0, MAX);
  const ql = q.toLowerCase();
  const scored: Scored[] = [];
  for (const p of paths) {
    const pl = p.toLowerCase();
    const slash = pl.lastIndexOf("/");
    const base = slash < 0 ? pl : pl.slice(slash + 1);
    let s = 0;
    let tier = 99;
    if (base.startsWith(ql)) {
      s = 100_000 - base.length;
      tier = 0;
    } else if (base.includes(ql)) {
      s = 50_000 - base.length;
      tier = 1;
    } else if (pl.includes(ql)) {
      s = 10_000 - p.length;
      tier = 2;
    } else {
      s = fuzzyScore(pl, ql);
      tier = 3;
    }
    if (s > 0) scored.push({ p, score: s, tier });
  }
  scored.sort(
    (a, b) => a.tier - b.tier || b.score - a.score || a.p.length - b.p.length,
  );
  return scored.slice(0, MAX).map((x) => x.p);
}
