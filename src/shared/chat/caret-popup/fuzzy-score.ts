export function fuzzyScore(name: string, q: string): number {
  let ni = 0;
  let qi = 0;
  let runs = 0;
  let last = -2;
  while (ni < name.length && qi < q.length) {
    if (name[ni] === q[qi]) {
      if (ni !== last + 1) runs++;
      last = ni;
      qi++;
    }
    ni++;
  }
  if (qi < q.length) return 0;
  return 1000 - runs * 50 - name.length;
}
