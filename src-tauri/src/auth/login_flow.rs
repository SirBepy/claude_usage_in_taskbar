//! One-time login flow: spawn Chrome, wait for user to log in, extract
//! sessionKey via CDP, kill Chrome.

use super::cdp;
use super::session;
use crate::settings::paths;
use anyhow::{anyhow, Context, Result};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::time::sleep;

const CDP_PORT: u16 = 9242; // avoid clashes with 9222
const LOGIN_TIMEOUT_SECS: u64 = 5 * 60;

fn find_browser() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let candidates = [
            std::env::var("ProgramFiles").ok().map(|p| format!("{p}/Google/Chrome/Application/chrome.exe")),
            std::env::var("ProgramFiles(x86)").ok().map(|p| format!("{p}/Google/Chrome/Application/chrome.exe")),
            std::env::var("LOCALAPPDATA").ok().map(|p| format!("{p}/Google/Chrome/Application/chrome.exe")),
            std::env::var("ProgramFiles(x86)").ok().map(|p| format!("{p}/Microsoft/Edge/Application/msedge.exe")),
            std::env::var("ProgramFiles").ok().map(|p| format!("{p}/Microsoft/Edge/Application/msedge.exe")),
        ];
        for c in candidates.into_iter().flatten() {
            let p = Path::new(&c);
            if p.exists() { return Some(p.to_path_buf()); }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let mut roots: Vec<PathBuf> = vec![PathBuf::from("/Applications")];
        if let Some(h) = dirs::home_dir() {
            roots.push(h.join("Applications"));
        }
        let apps: &[(&str, &str)] = &[
            ("Google Chrome.app", "Google Chrome"),
            ("Microsoft Edge.app", "Microsoft Edge"),
            ("Brave Browser.app", "Brave Browser"),
            ("Chromium.app", "Chromium"),
        ];
        for root in &roots {
            for (bundle, bin) in apps {
                let p = root.join(bundle).join("Contents/MacOS").join(bin);
                if p.exists() { return Some(p); }
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        // PATH lookup first - covers snap/flatpak/nix shims that wrap the real binary.
        let path_candidates = [
            "google-chrome",
            "google-chrome-stable",
            "chromium",
            "chromium-browser",
            "brave-browser",
            "microsoft-edge",
        ];
        for name in path_candidates {
            if let Ok(out) = Command::new("which").arg(name).output() {
                if out.status.success() {
                    let s = String::from_utf8_lossy(&out.stdout);
                    let trimmed = s.trim();
                    if !trimmed.is_empty() {
                        let p = PathBuf::from(trimmed);
                        if p.exists() { return Some(p); }
                    }
                }
            }
        }
        let absolute_candidates = [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/opt/google/chrome/google-chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
            "/usr/bin/brave-browser",
            "/usr/bin/microsoft-edge",
        ];
        for c in absolute_candidates {
            let p = Path::new(c);
            if p.exists() { return Some(p.to_path_buf()); }
        }
    }
    None
}

fn spawn_browser(bin: &Path, profile: &Path, port: u16) -> std::io::Result<Child> {
    Command::new(bin)
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg(format!("--remote-debugging-port={port}"))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("https://claude.ai/login")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
}

fn kill_browser(child: &mut Child) {
    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null()).stderr(Stdio::null())
            .status();
    }
    #[cfg(target_os = "macos")]
    {
        // Mac Chrome launched with --user-data-dir does not fork a detached
        // launcher; SIGTERM on the primary pid cleans up reliably.
        let _ = child.kill();
        let _ = child.wait();
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    { let _ = child.kill(); }
}

pub async fn run(app: AppHandle) -> Result<()> {
    let _ = app.emit("auth-progress", json!({"stage": "waiting-for-browser"}));

    let bin = find_browser()
        .ok_or_else(|| anyhow!(
            "No Chromium-based browser found. Install Google Chrome from https://www.google.com/chrome/"
        ))?;
    log::info!("launching browser: {}", bin.display());

    let profile = crate::settings::paths::data_dir()
        .context("data dir")?
        .join("chrome-login-profile");
    std::fs::create_dir_all(&profile).context("create profile dir")?;

    let mut child = spawn_browser(&bin, &profile, CDP_PORT)
        .context("spawn browser")?;

    let result = run_inner(&app, &mut child).await;
    kill_browser(&mut child);
    // NOTE: do NOT delete the profile dir, we want Google/SSO cookies to persist
    // across re-logins so the user only types their password once.

    match result {
        Ok(session_key) => {
            let session_path = paths::session_file()?;
            session::save(&session_path, &session_key)?;
            let _ = app.emit("auth-progress", json!({"stage": "done"}));
            Ok(())
        }
        Err(e) => {
            let _ = app.emit(
                "auth-progress",
                json!({"stage": "error", "message": e.to_string()}),
            );
            Err(e)
        }
    }
}

async fn run_inner(app: &AppHandle, _child: &mut Child) -> Result<String> {
    // Wait for CDP HTTP to come up
    let http = format!("http://127.0.0.1:{CDP_PORT}");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        if tokio::time::Instant::now() >= deadline {
            return Err(anyhow!("Chrome debugger never came up"));
        }
        if reqwest::get(format!("{http}/json/version")).await.is_ok() {
            break;
        }
        sleep(Duration::from_millis(400)).await;
    }

    let _ = app.emit("auth-progress", json!({"stage": "waiting-for-user"}));

    // Poll every ~1.5s for a claude.ai session until timeout
    let deadline = tokio::time::Instant::now()
        + Duration::from_secs(LOGIN_TIMEOUT_SECS);
    loop {
        if tokio::time::Instant::now() >= deadline {
            return Err(anyhow!("login timed out after 5 minutes"));
        }
        let ws_url = cdp::browser_ws_url(&http).await?;
        let cookies_result = cdp::call(
            &ws_url,
            "Storage.getCookies",
            json!({}),
            Duration::from_secs(5),
        ).await;
        if let Ok(result) = cookies_result {
            if let Some(cookies) = result.get("cookies").and_then(|x| x.as_array()) {
                for c in cookies {
                    let name = c.get("name").and_then(|x| x.as_str()).unwrap_or("");
                    let domain = c.get("domain").and_then(|x| x.as_str()).unwrap_or("");
                    if name == "sessionKey" && domain.ends_with("claude.ai") {
                        if let Some(v) = c.get("value").and_then(|x| x.as_str()) {
                            let _ = app.emit("auth-progress", json!({"stage": "extracting"}));
                            return Ok(v.to_string());
                        }
                    }
                }
            }
        }
        sleep(Duration::from_millis(1500)).await;
    }
}
