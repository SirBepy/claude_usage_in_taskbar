import { html, render } from "lit-html";

type RenderFn = (
  root: HTMLElement,
) => void | Promise<void> | (() => void) | Promise<() => void>;

const views = new Map<string, RenderFn>();

export function registerView(name: string, render: RenderFn): void {
  views.set(name, render);
}

export function isMigrated(name: string): boolean {
  return views.has(name);
}

let currentRoot: HTMLElement | null = null;
let currentTeardown: (() => void) | null = null;

export function mountRouter(root: HTMLElement): void {
  currentRoot = root;
  (window as unknown as {
    navigateTo: (name: string) => Promise<void>;
    isMigratedView: (name: string) => boolean;
  }).navigateTo = navigateTo;
  (window as unknown as {
    isMigratedView: (name: string) => boolean;
  }).isMigratedView = isMigrated;
  const initial = window.location.hash.replace(/^#/, "") || "sessions";
  void navigateTo(initial);
}

function hideAllLegacyViews(): void {
  document
    .querySelectorAll<HTMLElement>("body > .view")
    .forEach((el) => el.classList.add("hidden"));
}

function showLegacyView(name: string): void {
  const el = document.getElementById(`view-${name}`);
  if (el) el.classList.remove("hidden");
}

export async function navigateTo(name: string): Promise<void> {
  if (!currentRoot) return;
  currentTeardown?.();
  currentTeardown = null;
  const view = views.get(name);
  if (view) {
    hideAllLegacyViews();
    currentRoot.style.display = "";
    render(html``, currentRoot);
    const result = await view(currentRoot);
    if (typeof result === "function") currentTeardown = result;
  } else {
    render(html``, currentRoot);
    currentRoot.style.display = "none";
    hideAllLegacyViews();
    showLegacyView(name);
  }
  const updateActive = (window as unknown as {
    updateSidemenuActive?: (n: string) => void;
  }).updateSidemenuActive;
  updateActive?.(name);
  window.location.hash = name;
}
