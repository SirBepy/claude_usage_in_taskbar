//! Live integration tests against claude.ai.
//!
//! These tests read the sessionKey the app persists at
//! `%APPDATA%\claude-usage-tauri\session.txt` (written by the native-auth flow
//! in `src/auth.rs`) and exercise the real HTTP scraper end-to-end.
//!
//! Design goals (per WORKFLOWS_FOR_SIRBEPY discussion 2026-04-19):
//!   1. `auth_precheck` runs first and validates the saved session.
//!   2. When no session exists OR it returns 401, every live test PRINTS a
//!      clear login instruction and returns `Ok(())` — they do not fail the
//!      suite. This way Joe can run `cargo test` unconditionally; real network
//!      failures are the only thing that turns tests red.
//!   3. Setting env var `CLAUDE_LIVE_TESTS_STRICT=1` flips the skip into a
//!      hard fail. Useful for CI once auth is wired up there.

use claude_usage_tauri_lib::paths;
use claude_usage_tauri_lib::scraping::{self as scraper, ScrapeError};
use claude_usage_tauri_lib::auth::session;

const CLAUDE_BASE: &str = "https://claude.ai";

/// Result of attempting to resolve a working session.
enum LiveSession {
    Ok(String),
    Missing,
}

fn resolve_session() -> LiveSession {
    let Ok(path) = paths::session_file() else {
        return LiveSession::Missing;
    };
    match session::load(&path) {
        Some(key) => LiveSession::Ok(key),
        None => LiveSession::Missing,
    }
}

fn handle_skip(reason: &str) {
    let msg = format!(
        "\n\
         ────────────────────────────────────────────────────────────\n\
          LIVE TEST SKIPPED: {reason}\n\
          Fix: run `cd tauri && cargo tauri dev`, complete the Chrome\n\
          login flow; the app will write session.txt. Then re-run\n\
          `cargo test`.\n\
         ────────────────────────────────────────────────────────────\n"
    );
    if std::env::var("CLAUDE_LIVE_TESTS_STRICT").is_ok() {
        panic!("{msg}");
    }
    eprintln!("{msg}");
}

/// Gate helper: returns `Some(key)` when a live call is possible, else `None`
/// (with a skip message already printed).
async fn live_key() -> Option<String> {
    match resolve_session() {
        LiveSession::Ok(key) => {
            // Precheck: cheap GET /api/organizations to confirm the cookie is
            // still valid before spending time on the usage endpoint.
            match scraper::fetch_usage(CLAUDE_BASE, &key).await {
                Ok(_) => Some(key),
                Err(ScrapeError::Unauthorized) | Err(ScrapeError::Forbidden) => {
                    handle_skip("saved session rejected (401/403)");
                    None
                }
                Err(e) => {
                    // Network/other: don't silently skip — surface it.
                    panic!("live precheck failed with non-auth error: {e:?}");
                }
            }
        }
        LiveSession::Missing => {
            handle_skip("no session.txt on disk");
            None
        }
    }
}

#[tokio::test]
async fn auth_precheck_session_is_valid() {
    // This test IS the precheck. If it passes, downstream live tests can trust
    // the saved session. If it prints a skip, nothing below will run real HTTP.
    let _ = live_key().await;
}

#[tokio::test]
async fn live_fetch_usage_returns_sane_percentages() {
    let Some(key) = live_key().await else { return };

    let snap = scraper::fetch_usage(CLAUDE_BASE, &key)
        .await
        .expect("fetch_usage should succeed after precheck passed");

    // Utilisation is a percentage 0..=100 (can exceed 100 once extra_usage
    // kicks in, but never negative, never absurd).
    assert!(snap.five_hour.utilization >= 0.0, "session pct negative");
    assert!(snap.seven_day.utilization >= 0.0, "weekly pct negative");
    assert!(snap.five_hour.utilization < 1000.0, "session pct absurd: {}", snap.five_hour.utilization);
    assert!(snap.seven_day.utilization < 1000.0, "weekly pct absurd: {}", snap.seven_day.utilization);

    // resets_at must parse as a date.
    assert!(
        chrono::DateTime::parse_from_rfc3339(&snap.five_hour.resets_at).is_ok(),
        "five_hour.resets_at not RFC3339: {}", snap.five_hour.resets_at
    );
    assert!(
        chrono::DateTime::parse_from_rfc3339(&snap.seven_day.resets_at).is_ok(),
        "seven_day.resets_at not RFC3339: {}", snap.seven_day.resets_at
    );
}

#[tokio::test]
async fn live_extra_usage_fields_are_floats_when_present() {
    // Guards the regression fixed in commit 77c9bd5: the API returns
    // monthly_limit/used_credits as f64 (e.g. 1791.0), not u32.
    let Some(key) = live_key().await else { return };

    let snap = scraper::fetch_usage(CLAUDE_BASE, &key).await.unwrap();
    if let Some(extra) = snap.extra_usage {
        assert!(extra.monthly_limit >= 0.0);
        assert!(extra.used_credits >= 0.0);
        assert!(extra.utilization >= 0.0);
        assert!(!extra.currency.is_empty(), "currency string empty");
    }
}
