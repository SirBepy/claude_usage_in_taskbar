import { html, render } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import { invoke } from "../../shared/ipc";
import type { NewsPost } from "../../types/ipc.generated";
import "./news.css";

interface NewsState {
  posts: NewsPost[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  notifyEnabled: boolean;
}

const state: NewsState = {
  posts: [],
  loading: true,
  refreshing: false,
  error: null,
  notifyEnabled: false,
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

async function openPost(post: NewsPost): Promise<void> {
  try {
    await invoke("open_external", { url: post.url });
  } catch (err) {
    console.warn("[news] open_external failed", err);
    window.open(post.url, "_blank");
  }
  if (post.unread) {
    post.unread = false;
    try {
      await invoke("mark_news_read", { slug: post.slug });
    } catch (err) {
      console.warn("[news] mark_news_read failed", err);
    }
  }
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
          ${unreadCount > 0
            ? html`<button
                class="btn-secondary news-mark-all"
                @click=${() => markAllRead(root)}
                title="Mark all as read"
              >
                Mark all read
              </button>`
            : null}
          <button
            class="icon-btn"
            title=${state.refreshing ? "Refreshing..." : "Refresh"}
            ?disabled=${state.refreshing}
            @click=${() => refresh(root)}
          >
            <i class="ph ${state.refreshing ? "ph-spinner news-spin" : "ph-arrow-clockwise"}"></i>
          </button>
        </div>
      </div>
      <div class="view-body news-body">
        <div class="news-notify-row">
          <label class="news-notify-label">
            <i class="ph ph-bell"></i>
            Notify me on new posts
          </label>
          <label class="switch">
            <input
              type="checkbox"
              .checked=${state.notifyEnabled}
              @change=${(e: Event) => setNotifyEnabled((e.target as HTMLInputElement).checked, root)}
            />
            <span class="slider"></span>
          </label>
        </div>
        ${renderBody(root)}
      </div>
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
    ${state.posts.map((p) => renderItem(p))}
  </ul>`;
}

function renderItem(post: NewsPost) {
  const tldr = post.summary || post.excerpt || null;
  return html`
    <li
      class="news-item ${post.unread ? "news-item-unread" : ""}"
      @click=${() => openPost(post)}
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
      <i class="ph ph-arrow-up-right news-open-icon"></i>
    </li>
  `;
}

function paint(root: HTMLElement): void {
  render(template(root), root);
}

export async function renderNewsView(root: HTMLElement): Promise<() => void> {
  state.loading = true;
  state.error = null;
  paint(root);
  await Promise.all([fetchPosts(), loadNotifySetting()]);
  paint(root);

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
    try { unlisten(); } catch { /* ignore */ }
  };
}
