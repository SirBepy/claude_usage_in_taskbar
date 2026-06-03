import { html } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import MarkdownIt from "markdown-it";
import { invoke } from "../../shared/ipc";
import type { NewsPost } from "../../types/ipc.generated";
import { state, paint } from "./news-state";

// html: false escapes model output so unsafeHTML is safe here.
const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

export function openDetail(post: NewsPost, root: HTMLElement): void {
  state.selectedSlug = post.slug;
  paint(root);
  if (post.unread) {
    post.unread = false;
    void invoke("mark_news_read", { slug: post.slug }).catch((err) =>
      console.warn("[news] mark_news_read failed", err)
    );
  }
  if (!post.aiSummary) void ensureSummary(post, root);
}

export async function ensureSummary(post: NewsPost, root: HTMLElement): Promise<void> {
  if (post.aiSummary || state.generatingSlugs.has(post.slug)) return;
  state.generatingSlugs.add(post.slug);
  state.errorBySlug.delete(post.slug);
  state.streamBySlug.set(post.slug, "");
  state.phaseBySlug.set(post.slug, "fetching");
  paint(root);
  try {
    const updated = await invoke<NewsPost>("generate_news_summary", { slug: post.slug });
    const idx = state.posts.findIndex((p) => p.slug === post.slug);
    if (idx >= 0) state.posts[idx] = updated;
  } catch (err) {
    console.error("[news] generate_news_summary failed", err);
    state.errorBySlug.set(post.slug, String(err));
  } finally {
    state.generatingSlugs.delete(post.slug);
    state.streamBySlug.delete(post.slug);
    state.phaseBySlug.delete(post.slug);
    paint(root);
  }
}

export async function regenerate(post: NewsPost, root: HTMLElement): Promise<void> {
  if (state.generatingSlugs.has(post.slug)) return;
  state.errorBySlug.delete(post.slug);
  const idx = state.posts.findIndex((p) => p.slug === post.slug);
  const cleared: NewsPost = { ...(idx >= 0 ? state.posts[idx]! : post), aiSummary: null };
  if (idx >= 0) state.posts[idx] = cleared;
  await ensureSummary(cleared, root);
}

export function openOriginal(post: NewsPost): void {
  void invoke("open_external", { url: post.url }).catch(() => window.open(post.url, "_blank"));
}

export function renderDetail(post: NewsPost, root: HTMLElement) {
  return html`
    <div class="news-detail">
      <div class="news-detail-metabar">
        <div class="news-meta">
          ${post.category ? html`<span class="news-cat">${post.category}</span>` : null}
          <time class="news-date">${post.dateLabel}</time>
        </div>
        <button
          class="icon-btn"
          title="Open original article"
          @click=${() => openOriginal(post)}
        >
          <i class="ph ph-arrow-up-right"></i>
        </button>
      </div>
      <h3 class="news-detail-title">${post.title}</h3>
      ${renderSummaryBlock(post, root)}
    </div>
  `;
}

export function renderDetailMenu(post: NewsPost, root: HTMLElement) {
  const busy = state.generatingSlugs.has(post.slug);
  return html`
    <div class="news-menu" @click=${(e: Event) => e.stopPropagation()}>
      <button
        class="news-menu-item"
        ?disabled=${busy}
        @click=${() => { state.menuOpen = false; void regenerate(post, root); }}
      >
        <i class="ph ${busy ? "ph-spinner news-spin" : "ph-arrows-clockwise"}"></i>
        Regenerate summary
      </button>
    </div>
  `;
}

export function renderSummaryBlock(post: NewsPost, root: HTMLElement) {
  if (state.generatingSlugs.has(post.slug)) {
    const live = state.streamBySlug.get(post.slug) ?? "";
    if (live) {
      return html`<div class="news-summary news-summary-md news-summary-streaming">
        ${unsafeHTML(md.render(live))}
      </div>`;
    }
    const label = state.phaseBySlug.get(post.slug) === "writing" ? "Writing…" : "Fetching article…";
    return html`<div class="news-summary news-summary-loading">
      <i class="ph ph-spinner news-spin"></i> ${label}
    </div>`;
  }
  const err = state.errorBySlug.get(post.slug);
  if (err) {
    return html`<div class="news-summary news-summary-error">
      <p>Could not generate a summary.</p>
      <p class="news-error-msg">${err}</p>
      <button class="btn-secondary" @click=${() => ensureSummary(post, root)}>Retry</button>
    </div>`;
  }
  if (post.aiSummary) {
    return html`<div class="news-summary news-summary-md">
      ${unsafeHTML(md.render(post.aiSummary))}
    </div>`;
  }
  return html`<div class="news-summary news-summary-loading">
    <span>No summary yet.</span>
    <button class="btn-secondary" @click=${() => ensureSummary(post, root)}>Summarize</button>
  </div>`;
}
