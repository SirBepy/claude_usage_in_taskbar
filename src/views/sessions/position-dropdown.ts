export interface PositionDropdownOpts {
  align?: "left" | "right";
}

/** Position a dropdown menu below an anchor button, clamped to viewport edges.
 *  align:"right" (default) right-aligns the menu to the button's right edge.
 *  align:"left" left-aligns the menu to the button's left edge.
 */
export function positionDropdown(
  menu: HTMLElement,
  anchor: HTMLElement,
  opts?: PositionDropdownOpts,
): void {
  const align = opts?.align ?? "right";
  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let top = rect.bottom + 4;
  if (top + menuRect.height > window.innerHeight - 4) top = rect.top - menuRect.height - 4;
  menu.style.top = `${top}px`;
  if (align === "right") {
    menu.style.right = `${window.innerWidth - rect.right}px`;
    menu.style.left = "";
  } else {
    let left = rect.left;
    if (left + menuRect.width > window.innerWidth - 4) left = window.innerWidth - menuRect.width - 4;
    if (left < 4) left = 4;
    menu.style.left = `${left}px`;
    menu.style.right = "";
  }
}
