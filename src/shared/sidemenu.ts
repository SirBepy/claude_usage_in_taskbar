export function openSidemenu(): void {
  document.getElementById("sidemenu")?.classList.add("open");
  document.getElementById("sidemenuBackdrop")?.classList.add("open");
}

export function closeSidemenu(): void {
  document.getElementById("sidemenu")?.classList.remove("open");
  document.getElementById("sidemenuBackdrop")?.classList.remove("open");
}

export function updateSidemenuActive(viewName: string): void {
  document.querySelectorAll<HTMLElement>(".sidemenu-nav-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.view === viewName);
  });
}

// Back-compat: router.ts reads window.updateSidemenuActive to sync highlight.
(window as unknown as { updateSidemenuActive?: (n: string) => void }).updateSidemenuActive = updateSidemenuActive;
