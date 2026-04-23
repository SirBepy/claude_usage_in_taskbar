import { html, render } from "lit-html";
import "./notifications.css";

interface LegacyGlobals {
  navigateTo(name: string): Promise<void>;
  renderNotificationSettings?(): Promise<void> | void;
}

function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

export async function renderNotificationsView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);

  const backBtn = root.querySelector<HTMLButtonElement>(".back-to-settings");
  if (backBtn) backBtn.onclick = () => g().navigateTo("settings");

  try { await g().renderNotificationSettings?.(); }
  catch (e) { console.error("[notifications] render failed", e); }

  return () => { /* no teardown */ };
}

function template() {
  return html`
    <div class="view view-settings-notifications">
      <div class="view-header">
        <button class="icon-btn back-to-settings" title="Back">←</button>
        <h2>Notifications</h2>
        <div style="width:32px"></div>
      </div>
      <div class="view-body">
        <div class="section" id="muteSection">
          <div class="section-title">Mute</div>
          <div class="option">
            <span class="option-label">Mute all notifications</span>
            <label class="switch">
              <input type="checkbox" id="muteAllSwitch">
              <span class="slider"></span>
            </label>
          </div>
          <div class="option mute-child">
            <span class="option-label">Mute sounds</span>
            <label class="switch">
              <input type="checkbox" id="muteSoundsSwitch">
              <span class="slider"></span>
            </label>
          </div>
          <div class="option mute-child is-disabled" title="Coming soon - OS toasts aren't implemented yet">
            <span class="option-label">Mute system notifications <span style="color:var(--text-dim);font-size:0.75rem">(coming soon)</span></span>
            <label class="switch">
              <input type="checkbox" id="muteSystemSwitch" disabled>
              <span class="slider"></span>
            </label>
          </div>
        </div>
        <template id="notifCardTemplate">
          <div class="section notif-card">
            <div class="section-title notif-title"></div>
            <div class="option">
              <span class="option-label">Enabled</span>
              <label class="switch">
                <input type="checkbox" class="notif-enabled">
                <span class="slider"></span>
              </label>
            </div>
            <div class="option notif-body" style="display:none">
              <span class="option-label" style="font-size:0.82rem;color:var(--text-dim)">Type</span>
              <div style="display:flex;gap:10px">
                <label style="display:flex;align-items:center;gap:4px;font-size:0.85rem"><input type="radio" class="notif-mode" value="sound"> Sound</label>
                <label style="display:flex;align-items:center;gap:4px;font-size:0.85rem"><input type="radio" class="notif-mode" value="voice"> Voice</label>
              </div>
            </div>
            <div class="option notif-sound-row" style="display:none">
              <span class="option-label" style="font-size:0.82rem;color:var(--text-dim)">Sound</span>
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end">
                <select class="notif-sound-pack"></select>
                <select class="notif-sound-file"></select>
                <button class="btn-secondary notif-pack-install" style="display:none;padding:3px 10px;font-size:0.8rem">Install</button>
                <button class="btn-secondary notif-sound-preview" style="padding:3px 10px;font-size:0.8rem">▶</button>
              </div>
            </div>
            <div class="notif-voice-rows" style="display:none;flex-direction:column;gap:6px;padding:6px 0">
              <div class="option" style="border:none;padding:0">
                <span class="option-label" style="font-size:0.82rem;color:var(--text-dim)">Voice</span>
                <select class="notif-voice-select" style="flex:1;max-width:220px"></select>
              </div>
              <div class="option" style="border:none;padding:0;flex-direction:column;align-items:stretch;gap:4px">
                <span class="option-label notif-template-label" style="font-size:0.82rem;color:var(--text-dim)">Message</span>
                <div style="display:flex;align-items:center;gap:8px">
                  <input type="text" class="notif-template" style="flex:1;padding:4px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:0.85rem">
                  <button class="btn-secondary notif-voice-preview" style="padding:3px 10px;font-size:0.8rem">▶</button>
                </div>
                <span class="notif-template-hint" style="font-size:0.72rem;color:var(--text-dim)"></span>
              </div>
            </div>
          </div>
        </template>
        <div id="notifCards"></div>
        <div class="option" id="voicePreviewProjectRow" style="display:none">
          <span class="option-label" style="font-size:0.82rem;color:var(--text-dim)">Preview with project</span>
          <select id="voicePreviewProject" style="flex:1;max-width:220px"></select>
        </div>
      </div>
    </div>
  `;
}
