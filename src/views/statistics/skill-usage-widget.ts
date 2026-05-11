import { html, render, type TemplateResult } from "lit-html";
import { api } from "../../shared/api";
import type { SkillUsageEntry, SkillUsageWeek } from "../../types/ipc.generated";
import { showView } from "../../shared/navigation";
import "./skill-usage-widget.css";

const PIE_COLORS = ["#5b8def", "#8c5bef", "#ef5b8c", "#efbf5b", "#5befbf", "#888"];
const TOP_N = 5;

interface SortState { col: "tokens" | "inv" | "chats" | "perUse" | "skill"; dir: 1 | -1; }
let sort: SortState = { col: "tokens", dir: -1 };

function tokenTotal(e: SkillUsageEntry): number {
  return Number(e.tokens.input) + Number(e.tokens.output)
    + Number(e.tokens.cache_read) + Number(e.tokens.cache_create);
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return n.toString();
}

function sortValue(e: SkillUsageEntry, col: SortState["col"]): number | string {
  switch (col) {
    case "tokens": return tokenTotal(e);
    case "inv": return e.invocations.total;
    case "chats": return e.chats;
    case "perUse": return e.invocations.total === 0 ? 0 : tokenTotal(e) / e.invocations.total;
    case "skill": return e.skill;
  }
}

export function renderSkillUsageWidget(container: HTMLElement): () => void {
  let state: SkillUsageWeek | null = null;
  let loading = true;

  const draw = () => {
    if (loading) {
      render(html`<div class="skill-usage-widget loading">Loading skill usage&hellip;</div>`, container);
      return;
    }
    if (!state || state.entries.length === 0) {
      render(html`
        <div class="skill-usage-widget">
          <h3>Skills (last 7 days)</h3>
          <div class="empty">No skill usage tracked yet. The Stop hook installs automatically on the next Claude Code session.</div>
        </div>
      `, container);
      return;
    }

    const sorted = [...state.entries].sort((a, b) => {
      const av = sortValue(a, sort.col);
      const bv = sortValue(b, sort.col);
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * sort.dir;
      return String(av).localeCompare(String(bv)) * sort.dir;
    });

    const pieEntries = [...state.entries].sort((a, b) => tokenTotal(b) - tokenTotal(a));
    const top = pieEntries.slice(0, TOP_N);
    const rest = pieEntries.slice(TOP_N);
    const restTotal = rest.reduce((sum, e) => sum + tokenTotal(e), 0);
    const pieRows: { label: string; tokens: number; color: string }[] = top.map((e, i) => ({
      label: e.skill,
      tokens: tokenTotal(e),
      color: PIE_COLORS[i] ?? PIE_COLORS[PIE_COLORS.length - 1]!,
    }));
    if (restTotal > 0) {
      pieRows.push({ label: "Other", tokens: restTotal, color: PIE_COLORS[PIE_COLORS.length - 1]! });
    }

    render(html`
      <div class="skill-usage-widget">
        <h3>Skills (last 7 days)</h3>
        <div class="skill-usage-body">
          ${renderPie(pieRows)}
          ${renderTable(sorted, state.total_sessions)}
        </div>
      </div>
    `, container);
  };

  function renderTable(entries: SkillUsageEntry[], totalSessions: number): TemplateResult {
    const headerCell = (col: SortState["col"], label: string) => {
      const active = sort.col === col;
      const arrow = active ? (sort.dir === -1 ? " ▼" : " ▲") : "";
      const onClick = () => {
        if (sort.col === col) sort = { col, dir: sort.dir === -1 ? 1 : -1 };
        else sort = { col, dir: -1 };
        draw();
      };
      return html`<th class=${active ? "sort-active" : ""} @click=${onClick}>${label}${arrow}</th>`;
    };
    return html`
      <table class="skill-usage-table">
        <thead>
          <tr>
            ${headerCell("skill", "Skill")}
            ${headerCell("inv", "Inv")}
            ${headerCell("chats", "Chats")}
            <th>% Chats</th>
            ${headerCell("tokens", "Tokens")}
            ${headerCell("perUse", "Per use")}
          </tr>
        </thead>
        <tbody>
          ${entries.map((e) => html`
            <tr @click=${() => onRowClick(e.skill)}>
              <td>${e.skill}</td>
              <td>${e.invocations.total}</td>
              <td>${e.chats}</td>
              <td>${totalSessions === 0 ? "-" : Math.round((e.chats / totalSessions) * 100) + "%"}</td>
              <td>${fmtTokens(tokenTotal(e))}</td>
              <td>${e.invocations.total === 0 ? "-" : fmtTokens(Math.round(tokenTotal(e) / e.invocations.total))}</td>
            </tr>
          `)}
        </tbody>
      </table>
    `;
  }

  function renderPie(rows: { label: string; tokens: number; color: string }[]): TemplateResult {
    const total = rows.reduce((s, r) => s + r.tokens, 0);
    if (total === 0) return html`<div class="pie-empty">No token data</div>`;
    const r = 80;
    const cx = 100, cy = 100;
    let acc = 0;
    const sliceSvgs = rows.map((row) => {
      const start = (acc / total) * Math.PI * 2 - Math.PI / 2;
      acc += row.tokens;
      const end = (acc / total) * Math.PI * 2 - Math.PI / 2;
      const large = (end - start) > Math.PI ? 1 : 0;
      const x1 = cx + Math.cos(start) * r;
      const y1 = cy + Math.sin(start) * r;
      const x2 = cx + Math.cos(end) * r;
      const y2 = cy + Math.sin(end) * r;
      return `<path d="M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z" fill="${row.color}" stroke="#0a0a0a" stroke-width="1.5" />`;
    }).join("");
    const wrap = document.createElement("div");
    wrap.innerHTML = `<svg viewBox="0 0 200 200" width="200" height="200">${sliceSvgs}</svg>`;
    return html`
      <div class="pie-wrap">
        ${wrap}
        <ul class="pie-legend">
          ${rows.map((row) => html`
            <li><span class="swatch" style="background:${row.color}"></span>${row.label} &mdash; ${fmtTokens(row.tokens)}</li>
          `)}
        </ul>
      </div>
    `;
  }

  function onRowClick(skill: string) {
    (window as unknown as { skillDetailTarget?: string }).skillDetailTarget = skill;
    showView("skill-detail");
  }

  function load() {
    api.getSkillUsageWeek().then((w) => {
      state = w;
      loading = false;
      draw();
    }).catch((err) => {
      console.error("getSkillUsageWeek failed", err);
      loading = false;
      draw();
    });
  }

  draw();
  load();
  const unlisten = api.onSkillUsageChanged(() => load());

  return () => {
    try { unlisten(); } catch { /* ignore */ }
  };
}
