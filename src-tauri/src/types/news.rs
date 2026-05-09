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
    pub date_label: String,
    pub date_iso: Option<String>,
    pub unread: bool,
}
