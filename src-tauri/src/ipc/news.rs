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
