type RenderFn = (
  root: HTMLElement,
) => void | Promise<void> | (() => void) | Promise<() => void>;

const views = new Map<string, RenderFn>();

export function registerView(name: string, render: RenderFn): void {
  views.set(name, render);
}

let currentRoot: HTMLElement | null = null;
let currentTeardown: (() => void) | null = null;

export function mountRouter(root: HTMLElement): void {
  currentRoot = root;
  (window as unknown as { navigateTo: (name: string) => void }).navigateTo =
    navigateTo;
  const initial = window.location.hash.replace(/^#/, "") || "dashboard";
  void navigateTo(initial);
}

export async function navigateTo(name: string): Promise<void> {
  if (!currentRoot) return;
  const render = views.get(name);
  if (!render) {
    // Legacy code still owns rendering for views not yet migrated.
    console.warn(`[router] unknown view: ${name}, falling back to legacy`);
    return;
  }
  currentTeardown?.();
  currentTeardown = null;
  currentRoot.innerHTML = "";
  const result = await render(currentRoot);
  if (typeof result === "function") currentTeardown = result;
  window.location.hash = name;
}
