import { html, render } from "lit-html";
import { api } from "../../../../shared/api";
import { renderWhitelistEditor } from "../../../../shared/whitelist-editor";
import "./characters.css";

interface LegacyGlobals {
  navigateTo(name: string): Promise<void>;
}
function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

function template() {
  return html`
    <div class="view view-settings-characters">
      <div class="view-header">
        <button class="icon-btn back-to-settings" title="Back">←</button>
        <h2>Characters</h2>
        <div style="width:32px"></div>
      </div>
      <div class="view-body">
        <div class="kit-section">
          <p class="characters-hint">
            Default character whitelist for new projects. Each project starts by
            inheriting this list and can override it from its own Character whitelist screen.
          </p>
          <div id="default-whitelist-host"></div>
        </div>
      </div>
    </div>
  `;
}

export async function renderCharactersSettingsView(root: HTMLElement): Promise<() => void> {
  render(template(), root);

  const backBtn = root.querySelector<HTMLButtonElement>(".back-to-settings");
  if (backBtn) backBtn.onclick = () => g().navigateTo("settings");

  const host = root.querySelector<HTMLElement>("#default-whitelist-host");
  if (!host) return () => { /* nothing */ };

  let current = await api.getDefaultWhitelist();
  // The settings default can't reference itself; if somehow stored as "default",
  // present it as "all" so the editor has a concrete starting point.
  if (current.mode === "default") current = { mode: "all" };

  await renderWhitelistEditor(host, {
    value: current,
    allowDefault: false,
    onChange: (wl) => {
      void api.setDefaultWhitelist(wl).catch((e) => {
        console.error("[settings-characters] setDefaultWhitelist failed", e);
      });
    },
  });

  return () => { /* nothing to tear down */ };
}
