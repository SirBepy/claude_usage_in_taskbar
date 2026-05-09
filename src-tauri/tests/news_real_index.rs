//! Integration test that runs the index parser against a real snapshot of
//! https://www.anthropic.com/news. Catches regressions where Anthropic's
//! markup shifts and the selector mix needs updating. The fixture is a
//! verbatim curl response stored under tests/fixtures/.

use claude_usage_tauri_lib::news::scraper::parse_index;

const FIXTURE: &str = include_str!("fixtures/anthropic-news-2026-05-09.html");

#[test]
fn parser_extracts_all_eleven_news_links_from_real_index() {
    let items = parse_index(FIXTURE).expect("parse real anthropic.com/news");
    let slugs: std::collections::HashSet<&str> =
        items.iter().map(|i| i.slug.as_str()).collect();

    let expected = [
        "claude-opus-4-7",
        "claude-design-anthropic-labs",
        "claude-is-a-space-to-think",
        "higher-limits-spacex",
        "finance-agents",
        "enterprise-ai-services-company",
        "claude-for-creative-work",
        "theo-hourmouzis-general-manager-australia-new-zealand",
        "election-safeguards-update",
        "anthropic-nec",
        "anthropic-amazon-compute",
    ];

    let missing: Vec<&str> = expected.iter().copied()
        .filter(|s| !slugs.contains(s))
        .collect();
    assert!(
        missing.is_empty(),
        "parser dropped {} expected slug(s): {:?}\nGot {} total: {:?}",
        missing.len(), missing, items.len(), slugs,
    );
}

#[test]
fn parser_keeps_titles_and_dates_for_publication_list_items() {
    let items = parse_index(FIXTURE).expect("parse");
    let spacex = items.iter().find(|i| i.slug == "higher-limits-spacex")
        .expect("spacex present");
    assert!(spacex.title.contains("SpaceX"), "title: {:?}", spacex.title);
    assert_eq!(spacex.date_label, "May 6, 2026");
    assert_eq!(spacex.category.as_deref(), Some("Announcements"));
}
