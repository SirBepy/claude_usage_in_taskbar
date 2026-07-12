// Small action menu popped from the composer's split-send chevron. Body-appended,
// position:fixed, anchored off the chevron - mirrors the openSchedulePicker
// popover idiom and reuses its popover/row styles so there's no new chrome.
import "./schedule-picker.css";

export interface ComposerMenuItem {
  /** Phosphor icon name without the `ph-` prefix. */
  icon: string;
  label: string;
  run: () => void;
}

export function openComposerMenu(anchor: HTMLElement, items: ComposerMenuItem[]): void {
  if (items.length === 0) return;

  const pop = document.createElement("div");
  pop.className = "schedule-picker-popover composer-menu-popover";
  pop.innerHTML = `
    <div class="schedule-picker-rows">
      ${items
        .map(
          (it, i) => `
        <button type="button" class="schedule-picker-row" data-idx="${i}">
          <span class="schedule-picker-row-label"><i class="ph ph-${it.icon}"></i> ${it.label}</span>
        </button>`,
        )
        .join("")}
    </div>
  `;
  document.body.appendChild(pop);

  function close(): void {
    document.removeEventListener("mousedown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    pop.remove();
  }

  function onOutside(e: MouseEvent): void {
    if (!pop.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  function reposition(): void {
    const rect = anchor.getBoundingClientRect();
    const maxLeft = window.innerWidth - pop.offsetWidth - 8;
    pop.style.left = `${Math.max(8, Math.min(rect.right - pop.offsetWidth, maxLeft))}px`;
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceAbove >= pop.offsetHeight + 8 || spaceAbove >= spaceBelow) {
      pop.style.bottom = `${window.innerHeight - rect.top + 6}px`;
      pop.style.top = "";
    } else {
      pop.style.top = `${rect.bottom + 6}px`;
      pop.style.bottom = "";
    }
  }

  pop.querySelectorAll<HTMLButtonElement>("[data-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = items[Number(btn.dataset.idx)];
      close();
      item?.run();
    });
  });

  reposition();
  setTimeout(() => {
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
}
