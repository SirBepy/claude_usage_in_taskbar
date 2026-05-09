//! 6h background poll. Scrapes anthropic.com/news, merges into the on-disk
//! store, fetches og:image for any new slugs, then emits `news-updated` so
//! the renderer can refresh the badge + list. Errors are logged but never
//! propagate; the loop keeps running on the next tick.

use crate::news;
use crate::settings::paths;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const POLL_INTERVAL_SECS: u64 = 6 * 3600;
const STARTUP_DELAY_SECS: u64 = 45;

pub fn spawn_poll_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(STARTUP_DELAY_SECS)).await;
        loop {
            if let Err(e) = poll_once(&app).await {
                log::warn!("news poll failed: {e:#}");
            }
            tokio::time::sleep(Duration::from_secs(POLL_INTERVAL_SECS)).await;
        }
    });
}

pub async fn poll_once(app: &AppHandle) -> anyhow::Result<()> {
    let path = paths::news_file()?;
    let mut store = news::load(&path);
    let scraped = news::fetch_index().await?;
    let new_slugs = news::store::merge_scraped(&mut store, scraped);

    // Fetch the article-page summary for any post that doesn't have one yet.
    // This covers brand-new slugs and back-fills posts that were stored under
    // an older build that didn't capture summaries.
    let needs_summary: Vec<(String, String)> = store.posts.iter()
        .filter(|p| p.summary.is_none())
        .map(|p| (p.slug.clone(), p.url.clone()))
        .collect();
    for (slug, url) in needs_summary {
        match news::fetch_summary(&url).await {
            Ok(summary) => {
                if let Some(post) = store.posts.iter_mut().find(|p| p.slug == slug) {
                    post.summary = summary;
                }
            }
            Err(e) => log::warn!("summary fetch failed for {slug}: {e:#}"),
        }
    }
    store.last_fetch_at = Some(chrono::Utc::now().to_rfc3339());
    news::save(&path, &store)?;

    let new_count = new_slugs.len();
    let _ = app.emit("news-updated", serde_json::json!({
        "posts": store.posts,
        "newSlugs": new_slugs,
        "unreadCount": store.posts.iter().filter(|p| p.unread).count(),
    }));

    if new_count > 0 {
        if let Some(state) = app.try_state::<crate::state::AppState>() {
            let enabled = state.settings.lock().unwrap()
                .extra.get("newsNotificationsEnabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if enabled {
                let title = store.posts.iter()
                    .find(|p| Some(p.slug.as_str()) == new_slugs.first().map(|s| s.as_str()))
                    .map(|p| p.title.clone())
                    .unwrap_or_else(|| "New post from Anthropic".into());
                let body = if new_count > 1 {
                    format!("{title} (+{} more)", new_count - 1)
                } else {
                    title
                };
                let _ = app.emit("news-notification", serde_json::json!({
                    "title": "Anthropic news",
                    "body": body,
                }));
            }
        }
    }

    Ok(())
}
