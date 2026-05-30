import { html, render } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import MarkdownIt from "markdown-it";
import { openSidemenu } from "../../shared/sidemenu";
import { invoke } from "../../shared/ipc";
import type { NewsPost } from "../../types/ipc.generated";
import "./news.css";

// Renders the AI summary (Claude-authored Markdown) to HTML. `html: false`
// escapes any raw HTML in the model output, so unsafeHTML is safe here.
const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

interface NewsState {
  posts: NewsPost[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  notifyEnabled: boolean;
  menuOpen: boolean;
  detailMenuOpen: boolean;
  selectedSlug: string | null;
  generating: boolean;
  detailError: string | null;
}

const state: NewsState = {
  posts: [],
  loading: true,
  refreshing: false,
  error: null,
  notifyEnabled: false,
  menuOpen: false,
  detailMenuOpen: false,
  selectedSlug: null,
  generating: false,
  detailError: null,
};

interface SettingsLike { newsNotificationsEnabled?: boolean; [k: string]: unknown; }

async function loadNotifySetting(): Promise<void> {
  try {
    const s = await invoke<SettingsLike>("get_settings");
    state.notifyEnabled = !!s.newsNotificationsEnabled;
  } catch (err) {
    console.warn("[news] get_settings failed", err);
  }
}

async function setNotifyEnabled(v: boolean, root: HTMLElement): Promise<void> {
  state.notifyEnabled = v;
  paint(root);
  try {
    const s = await invoke<SettingsLike>("get_settings");
    s.newsNotificationsEnabled = v;
    await invoke("save_settings", { updated: s });
  } catch (err) {
    console.error("[news] save_settings failed", err);
  }
}

async function fetchPosts(): Promise<void> {
  try {
    state.posts = (await invoke<NewsPost[]>("list_news")) || [];
    state.error = null;
  } catch (err) {
    console.error("[news] list_news failed", err);
    state.error = String(err);
    state.posts = [];
  } finally {
    state.loading = false;
  }
}

async function refresh(root: HTMLElement): Promise<void> {
  state.refreshing = true;
  paint(root);
  try {
    state.posts = (await invoke<NewsPost[]>("refresh_news")) || [];
    state.error = null;
  } catch (err) {
    console.error("[news] refresh_news failed", err);
    state.error = String(err);
  } finally {
    state.refreshing = false;
    paint(root);
  }
}

function openDetail(post: NewsPost, root: HTMLElement): void {
  state.selectedSlug = post.slug;
  state.detailError = null;
  paint(root);
  if (post.unread) {
    post.unread = false;
    void invoke("mark_news_read", { slug: post.slug }).catch((err) =>
      console.warn("[news] mark_news_read failed", err)
    );
  }
  if (!post.aiSummary) void ensureSummary(post, root);
}

async function ensureSummary(post: NewsPost, root: HTMLElement): Promise<void> {
  if (post.aiSummary || state.generating) return;
  state.generating = true;
  state.detailError = null;
  paint(root);
  try {
    const updated = await invoke<NewsPost>("generate_news_summary", { slug: post.slug });
    const idx = state.posts.findIndex((p) => p.slug === post.slug);
    if (idx >= 0) state.posts[idx] = updated;
  } catch (err) {
    console.error("[news] generate_news_summary failed", err);
    state.detailError = String(err);
  } finally {
    state.generating = false;
    paint(root);
  }
}

async function regenerate(post: NewsPost, root: HTMLElement): Promise<void> {
  if (state.generating) return;
  // Clear the cached copy in-memory so ensureSummary re-runs.
  const idx = state.posts.findIndex((p) => p.slug === post.slug);
  const cleared: NewsPost = { ...(idx >= 0 ? state.posts[idx]! : post), aiSummary: null };
  if (idx >= 0) state.posts[idx] = cleared;
  await ensureSummary(cleared, root);
}

function openOriginal(post: NewsPost): void {
  void invoke("open_external", { url: post.url }).catch(() => window.open(post.url, "_blank"));
}

async function markAllRead(root: HTMLElement): Promise<void> {
  for (const p of state.posts) p.unread = false;
  paint(root);
  try {
    await invoke("mark_all_news_read");
  } catch (err) {
    console.warn("[news] mark_all_news_read failed", err);
  }
}

function template(root: HTMLElement) {
  const unreadCount = state.posts.filter((p) => p.unread).length;
  return html`
    <div class="view view-news">
      <div class="view-header">
        <button
          class="icon-btn burger"
          title="Menu"
          data-burger="true"
          @click=${openSidemenu}
        >
          <i class="ph ph-list"></i>
        </button>
        <h2>Anthropic news</h2>
        <div class="news-header-actions">
          <button
            class="icon-btn"
            title="More"
            aria-haspopup="true"
            aria-expanded=${state.menuOpen}
            @click=${(e: Event) => { e.stopPropagation(); state.menuOpen = !state.menuOpen; paint(root); }}
          >
            <i class="ph ph-dots-three-vertical"></i>
          </button>
          ${state.menuOpen ? renderMenu(root, unreadCount) : null}
        </div>
      </div>
      <div class="view-body news-body">
        ${state.selectedSlug ? renderDetail(root) : renderBody(root)}
      </div>
    </div>
  `;
}

function renderMenu(root: HTMLElement, unreadCount: number) {
  const close = () => { state.menuOpen = false; paint(root); };
  return html`
    <div class="news-menu" @click=${(e: Event) => e.stopPropagation()}>
      <button
        class="news-menu-item"
        ?disabled=${unreadCount === 0}
        @click=${() => { close(); void markAllRead(root); }}
      >
        <i class="ph ph-checks"></i> Mark all read
      </button>
      <button
        class="news-menu-item"
        ?disabled=${state.refreshing}
        @click=${() => { close(); void refresh(root); }}
      >
        <i class="ph ${state.refreshing ? "ph-spinner news-spin" : "ph-arrow-clockwise"}"></i>
        ${state.refreshing ? "Refreshing…" : "Refresh"}
      </button>
      <label class="news-menu-item news-menu-toggle">
        <span><i class="ph ph-bell"></i> Notify me on new posts</span>
        <label class="switch">
          <input
            type="checkbox"
            .checked=${state.notifyEnabled}
            @change=${(e: Event) => setNotifyEnabled((e.target as HTMLInputElement).checked, root)}
          />
          <span class="slider"></span>
        </label>
      </label>
    </div>
  `;
}

function renderBody(root: HTMLElement) {
  if (state.loading) {
    return html`<div class="news-empty">Loading…</div>`;
  }
  if (state.error && state.posts.length === 0) {
    return html`<div class="news-empty">
      <p>Could not load news.</p>
      <p class="news-error-msg">${state.error}</p>
      <button class="btn-secondary" @click=${() => refresh(root)}>Retry</button>
    </div>`;
  }
  if (state.posts.length === 0) {
    return html`<div class="news-empty">
      <p>No news yet.</p>
      <p>Click refresh to fetch from anthropic.com/news.</p>
      <button class="btn-secondary" @click=${() => refresh(root)}>Refresh</button>
    </div>`;
  }
  return html`<ul class="news-list">
    ${state.posts.map((p) => renderItem(p, root))}
  </ul>`;
}

function renderItem(post: NewsPost, root: HTMLElement) {
  const tldr = post.summary || post.excerpt || null;
  return html`
    <li
      class="news-item ${post.unread ? "news-item-unread" : ""}"
      @click=${() => openDetail(post, root)}
      title=${post.url}
    >
      <div class="news-text">
        <div class="news-meta">
          ${post.unread ? html`<span class="news-unread-dot" aria-label="unread"></span>` : null}
          ${post.category ? html`<span class="news-cat">${post.category}</span>` : null}
          <time class="news-date">${post.dateLabel}</time>
        </div>
        <div class="news-title">${post.title}</div>
        ${tldr ? html`<div class="news-excerpt">${tldr}</div>` : null}
      </div>
      <i class="ph ph-caret-right news-open-icon"></i>
    </li>
  `;
}

function renderDetail(root: HTMLElement) {
  const post = state.posts.find((p) => p.slug === state.selectedSlug);
  if (!post) {
    state.selectedSlug = null;
    return renderBody(root);
  }
  return html`
    <div class="news-detail">
      <button class="btn-secondary news-back" @click=${() => { state.selectedSlug = null; paint(root); }}>
        <i class="ph ph-arrow-left"></i> Back
      </button>
      <div class="news-meta">
        ${post.category ? html`<span class="news-cat">${post.category}</span>` : null}
        <time class="news-date">${post.dateLabel}</time>
      </div>
      <div class="news-detail-titlebar">
        <h3 class="news-detail-title">${post.title}</h3>
        <button
          class="icon-btn"
          title="Open original article"
          @click=${() => openOriginal(post)}
        >
          <i class="ph ph-arrow-up-right"></i>
        </button>
        <div class="news-detail-menu-wrap">
          <button
            class="icon-btn"
            title="More"
            aria-haspopup="true"
            aria-expanded=${state.detailMenuOpen}
            @click=${(e: Event) => { e.stopPropagation(); state.detailMenuOpen = !state.detailMenuOpen; paint(root); }}
          >
            <i class="ph ph-dots-three-vertical"></i>
          </button>
          ${state.detailMenuOpen ? renderDetailMenu(post, root) : null}
        </div>
      </div>
      ${renderSummaryBlock(post, root)}
    </div>
  `;
}

function renderDetailMenu(post: NewsPost, root: HTMLElement) {
  return html`
    <div class="news-menu" @click=${(e: Event) => e.stopPropagation()}>
      <button
        class="news-menu-item"
        ?disabled=${state.generating}
        @click=${() => { state.detailMenuOpen = false; void regenerate(post, root); }}
      >
        <i class="ph ${state.generating ? "ph-spinner news-spin" : "ph-arrows-clockwise"}"></i>
        Regenerate summary
      </button>
    </div>
  `;
}

function renderSummaryBlock(post: NewsPost, root: HTMLElement) {
  if (state.generating) {
    return html`<div class="news-summary news-summary-loading">
      <i class="ph ph-spinner news-spin"></i> Summarizing…
    </div>`;
  }
  if (state.detailError) {
    return html`<div class="news-summary news-summary-error">
      <p>Could not generate a summary.</p>
      <p class="news-error-msg">${state.detailError}</p>
      <button class="btn-secondary" @click=${() => ensureSummary(post, root)}>Retry</button>
    </div>`;
  }
  if (post.aiSummary) {
    return html`<div class="news-summary news-summary-md">
      ${unsafeHTML(md.render(post.aiSummary))}
    </div>`;
  }
  return html`<div class="news-summary news-summary-loading">Preparing…</div>`;
}

function paint(root: HTMLElement): void {
  render(template(root), root);
}

export async function renderNewsView(root: HTMLElement): Promise<() => void> {
  state.loading = true;
  state.error = null;
  state.menuOpen = false;
  state.detailMenuOpen = false;
  state.selectedSlug = null;
  state.detailError = null;
  paint(root);
  await Promise.all([fetchPosts(), loadNotifySetting()]);
  paint(root);

  // Close either popover menu on any click outside it.
  const onDocClick = () => {
    if (state.menuOpen || state.detailMenuOpen) {
      state.menuOpen = false;
      state.detailMenuOpen = false;
      paint(root);
    }
  };
  document.addEventListener("click", onDocClick);

  // e2e seam (DEV only): inject synthetic posts without a backend/claude call.
  const onInject = (e: Event) => {
    state.posts = ((e as CustomEvent).detail as NewsPost[]) || [];
    state.loading = false;
    paint(root);
  };
  if (import.meta.env.DEV) window.addEventListener("e2e-inject-news", onInject);

  // Live updates from the 6h backend poll, manual refreshes elsewhere, etc.
  type Unlisten = () => void;
  let unlisten: Unlisten = () => undefined;
  const ev = window.__TAURI__?.event;
  if (ev?.listen) {
    const p = ev.listen<{ posts: NewsPost[] }>("news-updated", (e) => {
      state.posts = e.payload?.posts || [];
      paint(root);
    });
    unlisten = () => { void p.then((u) => u()); };
  }

  return () => {
    document.removeEventListener("click", onDocClick);
    if (import.meta.env.DEV) window.removeEventListener("e2e-inject-news", onInject);
    try { unlisten(); } catch { /* ignore */ }
  };
}
