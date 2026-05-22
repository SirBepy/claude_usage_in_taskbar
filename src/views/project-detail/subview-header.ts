import { html } from "lit-html";
import type { TemplateResult } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import type { Avatar } from "../../shared/projects";
import { renderAvatar, hydrateCharacterAvatars, projectLabel } from "../../shared/projects";
import { getProjectDetailState, getSettings } from "../../shared/state";

export type { Avatar };

export function projectSubviewHeaderData(): { avatar: Avatar; title: string } {
  const cwd = getProjectDetailState().cwd || "";
  const settings = getSettings();
  const configured = (settings.projects || []).find((p: { path: string }) => p.path === cwd);
  const avatar: Avatar = (configured?.avatar as Avatar) || {
    kind: "emoji",
    value: (configured?.name || cwd || "?").charAt(0),
  };
  const aliases = settings.projectAliases || {};
  return { avatar, title: projectLabel(cwd, aliases) };
}

export function subviewHeaderTemplate(
  avatar: Avatar,
  title: string,
  onBack: () => void,
): TemplateResult {
  return html`
    <button class="icon-btn" title="Back" @click=${onBack}><i class="ph ph-arrow-left"></i></button>
    <div class="project-detail-heading">
      <div class="avatar-mini">${unsafeHTML(renderAvatar(avatar))}</div>
      <div class="project-detail-titles">
        <h2 style="font-size:0.88rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${title}</h2>
      </div>
    </div>
    <div style="width:32px"></div>
  `;
}

export async function hydrateSubviewHeader(root: HTMLElement): Promise<void> {
  const avatarEl = root.querySelector<HTMLElement>(".subview-header .avatar-mini");
  if (avatarEl) await hydrateCharacterAvatars(avatarEl);
}
