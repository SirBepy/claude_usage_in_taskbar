//! Lazily generates an ADHD-friendly Markdown "what shipped + why it matters"
//! summary of a news article by running a one-shot, billing-guarded `claude -p`
//! over the scraped article text. Subscription-billed (Pro/Max), same pool as
//! chat; refuses to run under any metered-billing env.
//!
//! The generation streams: it spawns claude with `--output-format stream-json
//! --include-partial-messages`, reads stdout line-by-line, and surfaces each
//! text delta via a callback so the UI can live-write the summary as it forms
//! (rather than freezing on a spinner for the whole 15-40s run).

use crate::chat::billing::check_metered_billing;
use crate::settings::paths;
use crate::types::NewsPost;
use crate::util::process::hide_console_tokio;
use anyhow::{anyhow, Context, Result};
use std::path::Path;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

/// Model used for news summaries. Hardcoded for v1 (low volume, so prose
/// quality beats haiku's marginal savings).
pub const SUMMARY_MODEL: &str = "sonnet";

/// Reasoning effort. A 2-section news summary needs no deep reasoning, so the
/// lowest effort - which is meaningfully faster + cheaper - is the right call.
pub const SUMMARY_EFFORT: &str = "low";

/// Builds the summarizer prompt: an ADHD-friendly, scannable Markdown summary
/// ("what shipped + why it matters" to a Claude / Claude Code power user).
pub fn build_prompt(title: &str, article_text: &str) -> String {
    format!(
        "Summarize this Anthropic announcement for a power user of Claude and \
Claude Code. Write it ADHD-friendly: short, scannable chunks, never walls of text. \
Use Markdown - a few small bold lead-ins or `###` sub-headings to break it up, \
**bold** for key terms, *italics* for nuance, and bullet lists where they fit. \
Cover what shipped and why it matters to someone using Claude and Claude Code daily. \
Be specific and concrete; skip marketing language and any preamble. Aim for a few \
tight chunks total.\n\nTitle: {title}\n\nArticle: {article_text}"
    )
}

/// Extracts the visible text chunk from one `stream-json` line, if it is a
/// `content_block_delta` carrying a `text_delta`. Returns None for every other
/// line (system init, thinking deltas, message/result envelopes, blank lines).
/// `text_delta` is emitted only for text content blocks, so this cleanly skips
/// thinking output (which uses `thinking_delta`/`signature_delta`).
fn parse_text_delta(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("type")?.as_str()? != "stream_event" {
        return None;
    }
    let event = v.get("event")?;
    if event.get("type")?.as_str()? != "content_block_delta" {
        return None;
    }
    let delta = event.get("delta")?;
    if delta.get("type")?.as_str()? != "text_delta" {
        return None;
    }
    Some(delta.get("text")?.as_str()?.to_string())
}

/// Spawns claude in the app-data dir (never the repo, so it can't ingest a stray
/// CLAUDE.md), streams its stdout, invokes `on_delta` for each text chunk as it
/// arrives, and returns the full trimmed summary. Errors if metered billing is
/// detected, claude is missing/non-zero, or the output is empty.
pub async fn generate_summary_streaming<F: FnMut(&str)>(
    title: &str,
    article_text: &str,
    mut on_delta: F,
) -> Result<String> {
    check_metered_billing(&|k| std::env::var(k).ok()).map_err(|e| anyhow!("{e}"))?;

    let cwd = paths::ensure_data_dir().context("resolve app-data dir")?;
    let prompt = build_prompt(title, article_text);

    let mut cmd = tokio::process::Command::new("claude");
    cmd.arg("-p")
        .arg(&prompt)
        .arg("--model")
        .arg(SUMMARY_MODEL)
        .arg("--effort")
        .arg(SUMMARY_EFFORT)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages")
        .current_dir(&cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    hide_console_tokio(&mut cmd);

    let mut child = cmd.spawn().context("spawn claude")?;
    let stdout = child.stdout.take().context("claude stdout")?;
    // Drain stderr concurrently so a chatty stderr can't fill its pipe and
    // deadlock the stdout read loop.
    let stderr = child.stderr.take();
    let stderr_task = tokio::spawn(async move {
        let mut s = String::new();
        if let Some(mut se) = stderr {
            let _ = se.read_to_string(&mut s).await;
        }
        s
    });

    let mut full = String::new();
    let mut lines = BufReader::new(stdout).lines();
    while let Some(line) = lines.next_line().await.context("read claude stdout")? {
        if let Some(chunk) = parse_text_delta(&line) {
            full.push_str(&chunk);
            on_delta(&chunk);
        }
    }

    let status = child.wait().await.context("wait claude")?;
    let stderr_out = stderr_task.await.unwrap_or_default();
    if !status.success() {
        return Err(anyhow!("claude exited {:?}: {}", status.code(), stderr_out.trim()));
    }
    let text = full.trim().to_string();
    if text.is_empty() {
        return Err(anyhow!("claude produced an empty summary"));
    }
    Ok(text)
}

/// Fetches the article for `slug`, streams a Markdown summary, writes the
/// `ai_summary*` fields back to the store, and returns the updated post. When
/// `emit` is true, fires `news-summary-phase` (fetching -> writing) and
/// `news-summary-delta` events keyed by slug so the open detail view can show
/// progress and live-write the text. On any failure nothing is persisted.
pub async fn generate_for_slug(
    app: &AppHandle,
    path: &Path,
    slug: &str,
    emit: bool,
) -> Result<NewsPost> {
    let (url, title) = {
        let store = crate::news::load(path);
        let post = store.posts.iter().find(|p| p.slug == slug)
            .ok_or_else(|| anyhow!("no post with slug {slug}"))?;
        (post.url.clone(), post.title.clone())
    };

    if emit {
        let _ = app.emit("news-summary-phase", serde_json::json!({ "slug": slug, "phase": "fetching" }));
    }
    let article_text = crate::news::scraper::fetch_article_text(&url).await?;

    if emit {
        let _ = app.emit("news-summary-phase", serde_json::json!({ "slug": slug, "phase": "writing" }));
    }
    let summary = {
        let app = app.clone();
        let slug = slug.to_string();
        generate_summary_streaming(&title, &article_text, |chunk| {
            if emit {
                let _ = app.emit("news-summary-delta", serde_json::json!({ "slug": slug, "chunk": chunk }));
            }
        })
        .await?
    };

    let mut store = crate::news::load(path);
    let post = store.posts.iter_mut().find(|p| p.slug == slug)
        .ok_or_else(|| anyhow!("no post with slug {slug}"))?;
    post.ai_summary = Some(summary);
    post.ai_summary_model = Some(SUMMARY_MODEL.to_string());
    post.ai_summary_at = Some(chrono::Utc::now().to_rfc3339());
    let snapshot = post.clone();
    crate::news::save(path, &store)?;
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_includes_title_article_and_markdown_instruction() {
        let p = build_prompt("Claude Opus 4.8", "Body text here.");
        assert!(p.contains("Claude Opus 4.8"));
        assert!(p.contains("Body text here."));
        assert!(p.contains("Markdown"));
        assert!(p.contains("why it matters"));
    }

    #[test]
    fn summary_model_and_effort_are_subscription_safe_and_fast() {
        // Metered refusal is covered by chat::billing tests; generate_*
        // calls check_metered_billing before spawning. Lock the wiring here.
        assert_eq!(SUMMARY_MODEL, "sonnet");
        assert_eq!(SUMMARY_EFFORT, "low");
    }

    #[test]
    fn parse_text_delta_extracts_visible_text_only() {
        let textline = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}}"#;
        assert_eq!(parse_text_delta(textline).as_deref(), Some("Hello"));
    }

    #[test]
    fn parse_text_delta_ignores_thinking_and_envelopes() {
        let thinking = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"abc"}}}"#;
        let start = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#;
        let system = r#"{"type":"system","subtype":"init"}"#;
        assert_eq!(parse_text_delta(thinking), None);
        assert_eq!(parse_text_delta(start), None);
        assert_eq!(parse_text_delta(system), None);
        assert_eq!(parse_text_delta(""), None);
        assert_eq!(parse_text_delta("not json"), None);
    }
}
