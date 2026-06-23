import { html, render } from "lit-html";
import { setActiveView } from "./shared/navigation";
import { noteNavigation } from "./shared/back-button";

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
  const initial = window.location.hash.replace(/^#/, "") || "dashboard";
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
  setActiveView(name);
  // Feed the back-button view stack so the phone's hardware back can step back
  // through screens (no-op recording on desktop).
  noteNavigation(name);
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
  // Update the hash WITHOUT adding a browser history entry. Pushing one (via
  // `location.hash = name`) is what let the phone's back button walk off the
  // SPA and close the app; the back-button trap owns history now. The hash
  // still drives deep-link / refresh restore (mountRouter reads it on boot).
  if (typeof history !== "undefined" && history.replaceState) {
    history.replaceState(history.state, "", `#${name}`);
  } else {
    window.location.hash = name;
  }
}
