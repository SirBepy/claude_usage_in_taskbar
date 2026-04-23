import { html, render } from "lit-html";
import "./notif-overrides.css";

interface LegacyGlobals {
  projectDetailState: { cwd: string | null };
  backFromSubview(): void;
  populateProjectSubviewHeader(prefix: string): void;
  renderProjectOverrides(cwd: string): void;
}

function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

export async function renderNotifOverridesView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);

  g().populateProjectSubviewHeader("notifOverrides");

  const backBtn = root.querySelector<HTMLButtonElement>("#notifOverridesBackBtn");
  if (backBtn) backBtn.onclick = () => g().backFromSubview();

  const cwd = g().projectDetailState?.cwd;
  if (cwd) {
    try {
      await g().renderProjectOverrides(cwd);
    } catch (e) {
      console.error("[notif-overrides] render failed", e);
    }
  }

  return () => { /* no teardown */ };
}

function template() {
  return html`
    <div class="view view-project-notif-overrides">
      <div class="view-header subview-header">
        <button class="icon-btn" id="notifOverridesBackBtn" title="Back"><i class="ph ph-arrow-left"></i></button>
        <div class="project-detail-heading">
          <div class="avatar-mini" id="notifOverridesAvatar">?</div>
          <div class="project-detail-titles">
            <h2 id="notifOverridesTitle" style="font-size:0.88rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Project</h2>
            <div class="project-detail-path" id="notifOverridesPath"></div>
          </div>
        </div>
        <div style="width:32px"></div>
      </div>
      <div class="view-body">
        <div class="section" style="margin-top:12px">
          <div class="section-title">Notification overrides</div>
          <template id="projectOverrideRowTemplate">
            <div class="project-override">
              <div class="option">
                <span class="option-label override-title"></span>
                <label class="switch">
                  <input type="checkbox" class="override-enabled">
                  <span class="slider"></span>
                </label>
              </div>
              <div class="override-body" style="display:none;padding-left:8px">
                <div class="option">
                  <span class="option-label" style="font-size:0.82rem;color:var(--text-dim)">Type</span>
                  <div style="display:flex;gap:10px">
                    <label style="display:flex;align-items:center;gap:4px;font-size:0.85rem"><input type="radio" class="override-mode" value="sound"> Sound</label>
                    <label style="display:flex;align-items:center;gap:4px;font-size:0.85rem"><input type="radio" class="override-mode" value="voice"> Voice</label>
                  </div>
                </div>
                <div class="option override-sound-row" style="display:none">
                  <span class="option-label" style="font-size:0.82rem;color:var(--text-dim)">Sound</span>
                  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end">
                    <select class="override-sound-pack"></select>
                    <select class="override-sound-file"></select>
                    <button class="btn-secondary override-pack-install" style="display:none;padding:3px 10px;font-size:0.8rem">Install</button>
                    <button class="btn-secondary override-sound-preview" style="padding:3px 10px;font-size:0.8rem">▶</button>
                  </div>
                </div>
                <div class="override-voice-rows" style="display:none;flex-direction:column;gap:6px;padding:6px 0">
                  <div class="option" style="border:none;padding:0">
                    <span class="option-label" style="font-size:0.82rem;color:var(--text-dim)">Voice</span>
                    <select class="override-voice-select" style="flex:1;max-width:220px"></select>
                  </div>
                  <div class="option" style="border:none;padding:0;flex-direction:column;align-items:stretch;gap:4px">
                    <span class="option-label" style="font-size:0.82rem;color:var(--text-dim)">Message</span>
                    <input type="text" class="override-template" style="padding:4px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:0.85rem">
                  </div>
                </div>
              </div>
            </div>
          </template>
          <div id="projectOverrideRows"></div>
        </div>
      </div>
    </div>
  `;
}
