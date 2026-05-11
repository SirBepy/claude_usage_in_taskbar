import { html, render, type TemplateResult } from "lit-html";
import { api } from "../../shared/api";
import type { SkillDetail, SkillUsageEvent } from "../../types/ipc.generated";
import { showView } from "../../shared/navigation";
import { openSidemenu } from "../../shared/sidemenu";
import "./skill-detail.css";

const SOURCE_COLORS = {
  manual: "#5b8def",
  skill: "#8c5bef",
  auto: "#888",
} as const;

function targetSkill(): string {
  return (window as unknown as { skillDetailTarget?: string }).skillDetailTarget ?? "";
}

function tokenTotal(e: SkillUsageEvent): number {
  return Number(e.tokens.input) + Number(e.tokens.output)
    + Number(e.tokens.cache_read) + Number(e.tokens.cache_create);
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return ts;
  }
}

export async function renderSkillDetailView(root: HTMLElement): Promise<() => void> {
  const skill = targetSkill();
  if (!skill) {
    render(html`<div class="skill-detail empty">No skill selected. <a href="#" @click=${(e: Event) => { e.preventDefault(); showView("statistics"); }}>Back to Statistics</a></div>`, root);
    return () => { /* noop */ };
  }

  const draw = (detail: SkillDetail | null) => {
    if (!detail) {
      render(html`<div class="skill-detail loading">Loading&hellip;</div>`, root);
      return;
    }
    render(buildView(detail), root);
  };

  draw(null);
  const detail = await api.getSkillUsageDetail(skill);
  draw(detail);

  const unlisten = api.onSkillUsageChanged(() => {
    void api.getSkillUsageDetail(skill).then(draw);
  });

  return () => {
    try { unlisten(); } catch { /* ignore */ }
  };
}

function buildView(d: SkillDetail): TemplateResult {
  return html`
    <div class="view view-skill-detail">
      <div class="view-header">
        <button class="icon-btn burger" title="Menu" data-burger="true" @click=${openSidemenu}>
          <i class="ph ph-list"></i>
        </button>
        <h2>${d.skill}</h2>
        <div style="width:32px"></div>
      </div>
      <div class="view-body">
        <div class="skill-detail-back">
          <a href="#" @click=${(e: Event) => { e.preventDefault(); showView("statistics"); }}>&larr; Statistics</a>
        </div>
        <div class="counters">
          ${counter("Total", d.invocations.total)}
          ${counter("Manual", d.invocations.manual)}
          ${counter("Skill-chained", d.invocations.skill)}
          ${counter("Auto", d.invocations.auto)}
        </div>
        ${sourcePie(d)}
        ${d.events.length === 0
          ? html`<div class="empty">No invocations recorded for this skill in the last 7 days.</div>`
          : html`
            <table class="invocations">
              <thead>
                <tr><th>Time</th><th>Project</th><th>Tokens</th><th>Source</th></tr>
              </thead>
              <tbody>
                ${d.events.map(eventRow)}
              </tbody>
            </table>
          `}
      </div>
    </div>
  `;
}

function counter(label: string, value: number): TemplateResult {
  return html`<div class="counter"><div class="value">${value}</div><div class="label">${label}</div></div>`;
}

function sourcePie(d: SkillDetail): TemplateResult {
  const total = d.invocations.total;
  if (total === 0) return html``;
  const rows: { label: string; n: number; color: string }[] = [
    { label: "Manual", n: d.invocations.manual, color: SOURCE_COLORS.manual },
    { label: "Skill", n: d.invocations.skill, color: SOURCE_COLORS.skill },
    { label: "Auto", n: d.invocations.auto, color: SOURCE_COLORS.auto },
  ].filter((r) => r.n > 0);
  const r = 50;
  const cx = 60, cy = 60;
  let acc = 0;
  const slices = rows.map((row) => {
    const start = (acc / total) * Math.PI * 2 - Math.PI / 2;
    acc += row.n;
    const end = (acc / total) * Math.PI * 2 - Math.PI / 2;
    const large = (end - start) > Math.PI ? 1 : 0;
    const x1 = cx + Math.cos(start) * r;
    const y1 = cy + Math.sin(start) * r;
    const x2 = cx + Math.cos(end) * r;
    const y2 = cy + Math.sin(end) * r;
    return `<path d="M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z" fill="${row.color}" stroke="#0a0a0a" stroke-width="1.5" />`;
  }).join("");
  const wrap = document.createElement("div");
  wrap.innerHTML = `<svg viewBox="0 0 120 120" width="120" height="120">${slices}</svg>`;
  return html`<div class="source-pie">${wrap}</div>`;
}

function eventRow(e: SkillUsageEvent): TemplateResult {
  return html`
    <tr>
      <td>${formatTime(e.ts)}</td>
      <td>${e.project}</td>
      <td>${tokenTotal(e).toLocaleString()}</td>
      <td><span class="badge badge-${e.source}">${e.source}</span></td>
    </tr>
  `;
}
