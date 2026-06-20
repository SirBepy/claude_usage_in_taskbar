const _closers: Array<() => void> = [];

export function registerMenuCloser(fn: () => void): void {
  if (!_closers.includes(fn)) _closers.push(fn);
}

export function closeAllMenus(): void {
  _closers.forEach(fn => fn());
}
