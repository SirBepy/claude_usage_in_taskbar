import type { SlashEntry, SlashSource } from "../../../types/ipc.generated";
import { invoke } from "../../ipc";
import type { BuiltinHandler } from "./index";
import "./help.css";

export const showHelp: BuiltinHandler = async (_parsed, ctx) => {
  let entries: SlashEntry[] = [];
  try {
    entries = await invoke<SlashEntry[]>("list_slash_commands", {
      projectDir: ctx.projectDir,
    });
  } catch (e) {
    console.error("[builtin /help] list_slash_commands failed", e);
  }

  const modal = document.createElement("div");
  modal.className = "builtin-help-backdrop";
  modal.innerHTML = `
    <div class="builtin-help" role="dialog" aria-modal="true">
      <header>
        <strong>Slash commands</strong>
        <button class="close-x" aria-label="Close">&times;</button>
      </header>
      <ul></ul>
    </div>
  `;
  const ul = modal.querySelector("ul")!;
  for (const e of entries) {
    const li = document.createElement("li");
    const head = document.createElement("div");
    head.className = "row-head";
    head.textContent = e.args ? `/${e.name} ${e.args}` : `/${e.name}`;
    const meta = document.createElement("div");
    meta.className = "row-meta";
    meta.textContent = `[${labelFor(e.source)}] ${e.description}`;
    li.appendChild(head);
    li.appendChild(meta);
    ul.appendChild(li);
  }

  const close = (): void => {
    modal.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };

  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
  modal.querySelector(".close-x")!.addEventListener("click", close);
  document.addEventListener("keydown", onKey);

  document.body.appendChild(modal);
};

function labelFor(s: SlashSource): string {
  const k = (s as { kind: string }).kind;
  if (k === "plugin-skill" || k === "plugin-command") {
    return `plugin:${(s as { plugin: string }).plugin}`;
  }
  return k;
}
