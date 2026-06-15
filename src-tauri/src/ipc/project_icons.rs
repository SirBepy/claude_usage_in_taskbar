//! Project face fallback: detect a project's own icon file or its tech stack so
//! the frontend can render a real logo instead of the `Avatar::None` placeholder
//! (ai_todo 99). Ported from server_supervisor's `icons.rs`. Read-only; both
//! commands fail soft (None) so a missing/odd project never breaks the list.

use crate::ipc::chat::attachments::AttachmentData;
use std::path::Path;

/// Max icon file size we'll inline as base64 (larger = skip, keeps the payload
/// sane). Matches server_supervisor.
const MAX_ICON_BYTES: u64 = 512 * 1024;

/// Icon/logo file candidates, priority-ordered (first existing wins). Mirrors
/// server_supervisor's CANDIDATES list.
const ICON_CANDIDATES: &[&str] = &[
    "icon.svg", "icon.png", "icon.ico",
    "logo.svg", "logo.png", "app-icon.png",
    "assets/icons/app_icon.svg", "assets/icons/app_icon.png",
    "assets/icon/app_icon.png", "assets/icon/icon.png",
    "assets/icon.svg", "assets/icon.png",
    "assets/logo.svg", "assets/logo.png",
    "assets/icons/logo.svg", "assets/icons/logo.png",
    "assets/images/logo.png",
    "favicon.svg", "favicon.ico", "favicon.png",
    "public/favicon.svg", "public/favicon.ico", "public/favicon.png",
    "public/logo.png",
    "static/favicon.svg", "static/favicon.ico", "static/favicon.png",
    "web/icons/Icon-192.png", "web/favicon.png",
    "src-tauri/icons/128x128.png", "src-tauri/icons/icon.png",
];

fn mime_for(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "svg" => Some("image/svg+xml"),
        "png" => Some("image/png"),
        "ico" => Some("image/x-icon"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

/// Detect a project's primary tech stack from marker files. Priority-ordered so
/// a more-specific marker wins over a generic `package.json` (e.g. a Tauri app
/// with a bundled frontend reads as `rust`, not `node`). Mirrors
/// server_supervisor's `detect_tech`.
fn detect_tech(root: &Path) -> Option<&'static str> {
    let has = |rel: &str| root.join(rel).exists();
    if has("pubspec.yaml") {
        return Some("flutter");
    }
    if has("Cargo.toml") {
        return Some("rust");
    }
    if has("pyproject.toml") || has("requirements.txt") || has("setup.py") || has("Pipfile") {
        return Some("python");
    }
    if has("go.mod") {
        return Some("go");
    }
    if has("deno.json") || has("deno.jsonc") {
        return Some("deno");
    }
    let has_dotnet = std::fs::read_dir(root).ok().is_some_and(|entries| {
        entries.flatten().any(|e| {
            e.path()
                .extension()
                .and_then(|x| x.to_str())
                .is_some_and(|x| x.eq_ignore_ascii_case("csproj") || x.eq_ignore_ascii_case("sln"))
        })
    });
    if has_dotnet {
        return Some("dotnet");
    }
    if has("package.json") {
        return Some("node");
    }
    None
}

/// The detected tech-stack key for a project dir (e.g. "rust", "node"), or None.
/// Cheap (a handful of file-existence checks); the frontend caches per path.
#[tauri::command]
pub fn get_project_tech(root: String) -> Option<String> {
    detect_tech(Path::new(&root)).map(|s| s.to_string())
}

/// The project's own icon/logo file as `{mime, base64}`, or None when no
/// candidate exists / it's too big / unreadable. Runs on the blocking pool
/// (file IO) so it never stalls the webview, mirroring `read_image_file`.
#[tauri::command]
pub async fn get_project_icon(root: String) -> Option<AttachmentData> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine;
        let dir = Path::new(&root);
        for cand in ICON_CANDIDATES {
            let path = dir.join(cand);
            let Ok(meta) = std::fs::metadata(&path) else { continue };
            if !meta.is_file() || meta.len() > MAX_ICON_BYTES {
                continue;
            }
            let Some(mime) = path.extension().and_then(|e| e.to_str()).and_then(mime_for) else {
                continue;
            };
            let Ok(bytes) = std::fs::read(&path) else { continue };
            let base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            return Some(AttachmentData { mime: mime.to_string(), base64 });
        }
        None
    })
    .await
    .ok()
    .flatten()
}
