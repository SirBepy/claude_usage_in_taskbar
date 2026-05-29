use crate::news;
use crate::settings::paths;
use crate::types::NewsPost;
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub async fn list_news() -> Result<Vec<NewsPost>, String> {
    let path = paths::news_file().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || Ok(news::load(&path).posts))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn refresh_news(app: AppHandle) -> Result<Vec<NewsPost>, String> {
    news::scheduler::poll_once(&app)
        .await
        .map_err(|e| format!("{e:#}"))?;
    let path = paths::news_file().map_err(|e| e.to_string())?;
    Ok(news::load(&path).posts)
}

#[tauri::command]
pub async fn mark_news_read(slug: String, app: AppHandle) -> Result<(), String> {
    let path = paths::news_file().map_err(|e| e.to_string())?;
    let store = tauri::async_runtime::spawn_blocking(move || {
        let mut store = news::load(&path);
        news::mark_read(&mut store, &slug);
        news::save(&path, &store).map(|_| store)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    let _ = app.emit("news-updated", serde_json::json!({
        "posts": store.posts,
        "newSlugs": Vec::<String>::new(),
        "unreadCount": store.posts.iter().filter(|p| p.unread).count(),
    }));
    Ok(())
}

/// Lazily generates (or regenerates) the Claude summary for one post. Fetches
/// the article text, runs the summarizer, writes `ai_summary*` back to the
/// store, and returns the updated post. On any failure nothing is persisted and
/// the error is surfaced to the caller. Subscription-billed.
#[tauri::command]
pub async fn generate_news_summary(slug: String, app: AppHandle) -> Result<NewsPost, String> {
    let path = paths::news_file().map_err(|e| e.to_string())?;

    // Snapshot the post's url + title without holding anything across awaits.
    let (url, title) = {
        let store = news::load(&path);
        let post = store.posts.iter().find(|p| p.slug == slug)
            .ok_or_else(|| format!("no post with slug {slug}"))?;
        (post.url.clone(), post.title.clone())
    };

    let article_text = news::scraper::fetch_article_text(&url)
        .await
        .map_err(|e| format!("fetch article: {e:#}"))?;
    let summary = news::generate_summary(&title, &article_text)
        .await
        .map_err(|e| format!("{e:#}"))?;

    let save_path = path.clone();
    let save_slug = slug.clone();
    let updated = tauri::async_runtime::spawn_blocking(move || -> Result<NewsPost, String> {
        let mut store = news::load(&save_path);
        let post = store.posts.iter_mut().find(|p| p.slug == save_slug)
            .ok_or_else(|| format!("no post with slug {save_slug}"))?;
        post.ai_summary = Some(summary);
        post.ai_summary_model = Some(news::SUMMARY_MODEL.to_string());
        post.ai_summary_at = Some(chrono::Utc::now().to_rfc3339());
        let snapshot = post.clone();
        news::save(&save_path, &store).map_err(|e| e.to_string())?;
        Ok(snapshot)
    })
    .await
    .map_err(|e| e.to_string())??;

    let posts = news::load(&path).posts;
    let _ = app.emit("news-updated", serde_json::json!({
        "posts": posts,
        "newSlugs": Vec::<String>::new(),
        "unreadCount": store_unread(&path),
    }));
    Ok(updated)
}

/// Current unread count from the on-disk store (cosmetic; the renderer recomputes).
fn store_unread(path: &std::path::Path) -> usize {
    news::load(path).posts.iter().filter(|p| p.unread).count()
}

#[tauri::command]
pub async fn mark_all_news_read(app: AppHandle) -> Result<(), String> {
    let path = paths::news_file().map_err(|e| e.to_string())?;
    let store = tauri::async_runtime::spawn_blocking(move || {
        let mut store = news::load(&path);
        news::mark_all_read(&mut store);
        news::save(&path, &store).map(|_| store)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    let _ = app.emit("news-updated", serde_json::json!({
        "posts": store.posts,
        "newSlugs": Vec::<String>::new(),
        "unreadCount": 0u32,
    }));
    Ok(())
}
