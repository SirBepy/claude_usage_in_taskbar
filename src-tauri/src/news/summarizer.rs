//! Lazily generates a 2-paragraph "what shipped + why it matters" summary of a
//! news article by running a one-shot, billing-guarded `claude -p` over the
//! scraped article text. Subscription-billed (Pro/Max), same pool as chat; it
//! refuses to run under any metered-billing env.

use crate::chat::billing::check_metered_billing;
use crate::settings::paths;
use crate::types::NewsPost;
use crate::util::process::hide_console_tokio;
use anyhow::{anyhow, Context, Result};
use std::path::Path;

/// Model used for news summaries. Hardcoded for v1 (low volume, so prose
/// quality beats haiku's marginal savings).
pub const SUMMARY_MODEL: &str = "sonnet";

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

/// Fetches the article text for `slug`, generates its Markdown summary, writes
/// the `ai_summary*` fields back to the store at `path`, and returns the updated
/// post. Does NOT emit any event - the caller decides whether to notify the UI.
/// On any failure nothing is persisted.
pub async fn generate_for_slug(path: &Path, slug: &str) -> Result<NewsPost> {
    let (url, title) = {
        let store = crate::news::load(path);
        let post = store.posts.iter().find(|p| p.slug == slug)
            .ok_or_else(|| anyhow!("no post with slug {slug}"))?;
        (post.url.clone(), post.title.clone())
    };

    let article_text = crate::news::scraper::fetch_article_text(&url).await?;
    let summary = generate_summary(&title, &article_text).await?;

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

/// Runs `claude -p <prompt> --model <SUMMARY_MODEL> --output-format text` in the
/// app-data dir (never the repo, so claude doesn't ingest a stray CLAUDE.md),
/// with the console window suppressed. Returns the trimmed stdout summary.
/// Errors if metered billing is detected, claude is missing/non-zero, or stdout
/// is empty.
pub async fn generate_summary(title: &str, article_text: &str) -> Result<String> {
    check_metered_billing(&|k| std::env::var(k).ok())
        .map_err(|e| anyhow!("{e}"))?;

    let cwd = paths::ensure_data_dir().context("resolve app-data dir")?;
    let prompt = build_prompt(title, article_text);

    let mut cmd = tokio::process::Command::new("claude");
    cmd.arg("-p")
        .arg(&prompt)
        .arg("--model")
        .arg(SUMMARY_MODEL)
        .arg("--output-format")
        .arg("text")
        .current_dir(&cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    hide_console_tokio(&mut cmd);

    let out = cmd.output().await.context("spawn claude")?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(anyhow!("claude exited {:?}: {}", out.status.code(), stderr.trim()));
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        return Err(anyhow!("claude produced an empty summary"));
    }
    Ok(text)
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
    fn summary_model_is_subscription_safe_default() {
        // The metered refusal itself is covered by chat::billing unit tests;
        // generate_summary calls check_metered_billing before spawning (visible
        // above). Here we just lock the model wiring to the safe default.
        assert_eq!(SUMMARY_MODEL, "sonnet");
    }
}
