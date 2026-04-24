import { html, render } from "lit-html";
import { showToast } from "../../../../shared/toast";
import { backFromSubview } from "../../../../shared/navigation";
import { getProjectDetailState } from "../../../../shared/state";
import { populateProjectSubviewHeader } from "../sessions-list/sessions-list";
import { api } from "../../../../shared/api";
import "./automation.css";

interface Automation {
  enabled?: boolean;
  autostart_on_boot?: boolean;
  continue_flag?: boolean;
  session_name_prefix?: string | null;
}

interface ProjectCfg {
  id: string;
  path: string;
  automation?: Automation | null;
}

async function renderAutomationForm(): Promise<void> {
  const cwd = getProjectDetailState().cwd;
  if (!cwd) return;
  const projects = (await api.listProjects()) as unknown as ProjectCfg[];
  const proj = projects.find((p) => p.path === cwd);
  const empty = document.getElementById("automationEmpty") as HTMLElement | null;
  const form = document.getElementById("automationForm") as HTMLElement | null;
  if (!empty || !form) return;
  if (!proj || !proj.automation) {
    empty.style.display = "";
    form.style.display = "none";
    return;
  }
  empty.style.display = "none";
  form.style.display = "block";
  const enabled = document.getElementById("automationEnabled") as HTMLInputElement | null;
  const autostart = document.getElementById("automationAutostart") as HTMLInputElement | null;
  const cont = document.getElementById("automationContinue") as HTMLInputElement | null;
  const prefix = document.getElementById("automationPrefix") as HTMLInputElement | null;
  if (enabled) enabled.checked = !!proj.automation.enabled;
  if (autostart) autostart.checked = !!proj.automation.autostart_on_boot;
  if (cont) cont.checked = !!proj.automation.continue_flag;
  if (prefix) prefix.value = proj.automation.session_name_prefix || "";
  form.dataset.projectId = proj.id;
}

export async function renderAutomationView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);

  populateProjectSubviewHeader("automation");

  const backBtn = root.querySelector<HTMLButtonElement>("#automationBackBtn");
  if (backBtn) backBtn.onclick = () => backFromSubview();

  const automate = root.querySelector<HTMLButtonElement>("#automateChannelBtn");
  if (automate) {
    automate.onclick = async () => {
      const cwd = getProjectDetailState().cwd;
      if (!cwd) return;
      let proj: ProjectCfg;
      try { proj = (await api.ensureProject(cwd)) as unknown as ProjectCfg; }
      catch (e) { return showToast(`Could not register project: ${e}`); }
      await api.updateProject(proj.id, {
        automation: {
          enabled: false,
          autostart_on_boot: true,
          session_name_prefix: null,
          continue_flag: true,
        },
      });
      await renderAutomationForm();
      showToast("Automation added. Flip Enabled to start it.");
    };
  }

  const applyBtn = root.querySelector<HTMLButtonElement>("#automationApplyBtn");
  if (applyBtn) {
    applyBtn.onclick = async () => {
      const form = document.getElementById("automationForm") as HTMLElement | null;
      const projectId = form?.dataset.projectId;
      if (!projectId) return;
      const enabled = (document.getElementById("automationEnabled") as HTMLInputElement).checked;
      const autostart = (document.getElementById("automationAutostart") as HTMLInputElement).checked;
      const cont = (document.getElementById("automationContinue") as HTMLInputElement).checked;
      const prefix = (document.getElementById("automationPrefix") as HTMLInputElement).value.trim() || null;
      await api.updateProject(projectId, {
        automation: {
          enabled, autostart_on_boot: autostart,
          session_name_prefix: prefix, continue_flag: cont,
        },
      });
      if (enabled) {
        try { await api.spawnChannel(projectId); }
        catch (e) { showToast(`Spawn failed: ${e}`); }
      } else {
        try { await api.stopChannel(projectId); } catch { /* ignore */ }
      }
      showToast("Automation updated.");
    };
  }

  const removeBtn = root.querySelector<HTMLButtonElement>("#automationRemoveBtn");
  if (removeBtn) {
    removeBtn.onclick = async () => {
      const form = document.getElementById("automationForm") as HTMLElement | null;
      const projectId = form?.dataset.projectId;
      if (!projectId) return;
      try { await api.stopChannel(projectId); } catch { /* ignore */ }
      await api.updateProject(projectId, { automation: null });
      await renderAutomationForm();
      showToast("Automation removed.");
    };
  }

  await renderAutomationForm();

  return () => { /* no teardown */ };
}

function template() {
  return html`
    <div class="view view-project-automation">
      <div class="view-header subview-header">
        <button class="icon-btn" id="automationBackBtn" title="Back"><i class="ph ph-arrow-left"></i></button>
        <div class="project-detail-heading">
          <div class="avatar-mini" id="automationAvatar">?</div>
          <div class="project-detail-titles">
            <h2 id="automationTitle" style="font-size:0.88rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Project</h2>
            <div class="project-detail-path" id="automationPath"></div>
          </div>
        </div>
        <div style="width:32px"></div>
      </div>
      <div class="view-body">
        <section class="automation-section" id="automationSection" style="margin-top:12px">
          <div class="section-title">Automation</div>
          <div id="automationEmpty" class="no-data" style="display:flex;flex-direction:column;gap:8px;align-items:flex-start">
            <span>No automation configured. Click to have this project's Claude Code session start at boot and stay alive.</span>
            <button class="automate-cta" id="automateChannelBtn">+ Automate channel</button>
          </div>
          <div id="automationForm" style="display:none">
            <div class="option">
              <span class="option-label">Enabled</span>
              <label class="switch"><input type="checkbox" id="automationEnabled"><span class="slider"></span></label>
            </div>
            <div class="option">
              <span class="option-label">Start on boot</span>
              <label class="switch"><input type="checkbox" id="automationAutostart"><span class="slider"></span></label>
            </div>
            <div class="option">
              <span class="option-label">Continue previous session (<code>--continue</code>)</span>
              <label class="switch"><input type="checkbox" id="automationContinue"><span class="slider"></span></label>
            </div>
            <div class="option">
              <span class="option-label">Session name prefix</span>
              <input type="text" id="automationPrefix" class="inline-input" placeholder="(uses project name)">
            </div>
            <div style="display:flex;gap:6px;margin-top:8px">
              <button class="btn-secondary" id="automationRemoveBtn">Remove automation</button>
              <div style="flex:1"></div>
              <button class="btn-primary" id="automationApplyBtn">Apply</button>
            </div>
          </div>
        </section>
      </div>
    </div>
  `;
}
