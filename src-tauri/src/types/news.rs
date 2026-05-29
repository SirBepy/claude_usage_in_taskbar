use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct NewsPost {
    pub slug: String,
    pub url: String,
    pub title: String,
    pub category: Option<String>,
    pub excerpt: Option<String>,
    /// One-sentence TLDR from the article's `<meta name="description">`.
    /// Written by Anthropic, fetched per-article on first sighting.
    pub summary: Option<String>,
    /// Claude-generated 2-paragraph summary ("what shipped + why it matters").
    /// Lazily generated on first detail-view open and cached here; distinct
    /// from `summary`, which is Anthropic's own meta-description.
    pub ai_summary: Option<String>,
    /// Model used for `ai_summary` (e.g. "sonnet"). None until generated.
    pub ai_summary_model: Option<String>,
    /// RFC3339 timestamp of the last `ai_summary` generation. None until generated.
    pub ai_summary_at: Option<String>,
    pub date_label: String,
    pub date_iso: Option<String>,
    pub unread: bool,
}
