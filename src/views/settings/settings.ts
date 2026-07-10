import { html, render } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import { settingsHeader, navRow } from "./ui";
import "./settings.css";

interface LegacyGlobals {
  navigateTo(name: string): Promise<void>;
}

function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

export async function renderSettingsView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);

  const burger = root.querySelector<HTMLButtonElement>('[data-burger="true"]');
  if (burger) burger.onclick = () => openSidemenu();

  return () => {};
}

function template() {
  const nav = (name: string) => void g().navigateTo(name);
  return html`
    <div class="view view-settings">
      ${settingsHeader("Settings", { burger: true })}
      <div class="view-body">

        <div class="kit-section">
          <div class="kit-section-title">General</div>
          ${navRow("Appearance", "ph-paint-brush", () => nav("settings-appearance"))}
          ${navRow("Notifications & Sound", "ph-bell", () => nav("settings-notifications"))}
          ${navRow("Characters", "ph-smiley", () => nav("settings-characters"))}
        </div>

        <div class="kit-section">
          <div class="kit-section-title">Chats</div>
          ${navRow("Chat defaults", "ph-chats-circle", () => nav("settings-chat-defaults"))}
          ${navRow("Permissions", "ph-shield-check", () => nav("settings-permissions"))}
          ${navRow("Statusline", "ph-list-dashes", () => nav("settings-statusline"))}
        </div>

        <div class="kit-section">
          <div class="kit-section-title">Accounts</div>
          ${navRow("Claude accounts", "ph-user-circle", () => nav("settings-accounts"))}
          ${navRow("Remote access", "ph-device-mobile", () => nav("settings-remote-access"))}
        </div>

        <div class="kit-section">
          <div class="kit-section-title">System</div>
          ${navRow("System", "ph-gear", () => nav("settings-system"))}
          ${navRow("About & updates", "ph-info", () => nav("settings-about"))}
        </div>

      </div>
    </div>
  `;
}
