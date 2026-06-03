import type { RenderedMessage } from "./chat-transforms";

export function applyTurnCollapse(
  messages: RenderedMessage[],
  messageEls: HTMLElement[],
  start: number,
  end: number,
): void {
  if (end <= start) return;

  let lastAssistantIdx = -1;
  for (let i = end - 1; i >= start; i--) {
    if (messages[i]?.kind === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }

  const intermediateEnd = lastAssistantIdx === -1 ? end : lastAssistantIdx;
  const intermediateCount = intermediateEnd - start;

  if (lastAssistantIdx !== -1 && messageEls[lastAssistantIdx]) {
    messageEls[lastAssistantIdx]!.classList.remove("msg--working");
  }

  if (intermediateCount === 0) return;

  const firstEl = messageEls[start];
  if (!firstEl || !firstEl.parentElement) return;

  const details = document.createElement("details");
  details.className = "turn-steps";
  const summary = document.createElement("summary");
  summary.className = "turn-steps-summary";
  const label = `${intermediateCount} step${intermediateCount !== 1 ? "s" : ""}`;
  summary.innerHTML = `<i class="ph ph-list-bullets"></i> ${label}`;
  details.appendChild(summary);

  firstEl.parentElement.insertBefore(details, firstEl);
  for (let i = start; i < intermediateEnd; i++) {
    const el = messageEls[i];
    if (el) details.appendChild(el);
  }
}

/** Clamp over-long user messages behind a "Show more" toggle. Idempotent via data-clamp-checked. */
export function clampUserMessages(messages: RenderedMessage[], messageEls: HTMLElement[]): void {
  const MAX_PX = 220;
  for (let i = 0; i < messageEls.length; i++) {
    if (messages[i]?.kind !== "user") continue;
    const el = messageEls[i];
    if (!el || el.dataset.clampChecked) continue;
    el.dataset.clampChecked = "1";
    if (el.scrollHeight <= MAX_PX + 40) continue;
    const body = document.createElement("div");
    body.className = "msg-clamp-body";
    while (el.firstChild) body.appendChild(el.firstChild);
    el.appendChild(body);
    el.classList.add("has-clamp");
    const toggle = document.createElement("button");
    toggle.className = "msg-clamp-toggle";
    toggle.textContent = "Show more";
    toggle.addEventListener("click", () => {
      const expanded = el.classList.toggle("expanded");
      toggle.textContent = expanded ? "Show less" : "Show more";
    });
    el.appendChild(toggle);
  }
}
