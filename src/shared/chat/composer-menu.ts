// Small action menu popped from the composer's split-send chevron. Body-appended,
// position:fixed, anchored off the chevron - mirrors the openSchedulePicker
// popover idiom and reuses its popover/row styles so there's no new chrome.
import { openAnchoredPopover } from "./anchored-popover";
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

  const popover = openAnchoredPopover({
    anchor,
    el: pop,
    onClose: () => pop.remove(),
  });

  pop.querySelectorAll<HTMLButtonElement>("[data-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = items[Number(btn.dataset.idx)];
      popover.close();
      item?.run();
    });
  });

  popover.reposition();
}
