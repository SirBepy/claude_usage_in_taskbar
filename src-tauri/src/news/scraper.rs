//! Scrapes anthropic.com/news. The page is server-rendered (Next.js SSR);
//! every news article appears as `<a href="/news/<slug>">` containing a title,
//! a `<time>` label, a `<span class="caption bold">` category, and a `<p
//! class="body-3 ...">` excerpt. The class names are CSS-modules-hashed so we
//! match by structural shape and stable substrings rather than full names.

use anyhow::{anyhow, Result};
use scraper::{Html, Selector};

const NEWS_INDEX: &str = "https://www.anthropic.com/news";
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

#[derive(Debug, Clone)]
pub struct ScrapedItem {
    pub slug: String,
    pub url: String,
    pub title: String,
    pub category: Option<String>,
    pub excerpt: Option<String>,
    pub date_label: String,
}

pub async fn fetch_index() -> Result<Vec<ScrapedItem>> {
    let body = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()?
        .get(NEWS_INDEX)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    parse_index(&body)
}

pub fn parse_index(html: &str) -> Result<Vec<ScrapedItem>> {
    let doc = Html::parse_document(html);
    let a_sel = Selector::parse(r#"a[href^="/news/"]"#)
        .map_err(|e| anyhow!("a selector: {e:?}"))?;
    // Title: heading tags (FeaturedGrid) OR an element whose class contains
    // "title" (PublicationList uses `<span class="...__title body-3">`).
    let title_sel = Selector::parse(r#"h1, h2, h3, h4, h5, h6, [class*="title" i], [class*="Title" i]"#)
        .map_err(|e| anyhow!("title selector: {e:?}"))?;
    let time_sel = Selector::parse("time")
        .map_err(|e| anyhow!("time selector: {e:?}"))?;
    // Category: FeaturedGrid uses `caption`, PublicationList uses `subject`.
    let cat_sel = Selector::parse(r#"[class*="caption" i], [class*="subject" i]"#)
        .map_err(|e| anyhow!("cat selector: {e:?}"))?;
    let p_sel = Selector::parse("p")
        .map_err(|e| anyhow!("p selector: {e:?}"))?;

    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for a in doc.select(&a_sel) {
        let href = a.value().attr("href").unwrap_or("");
        let slug = href.trim_start_matches("/news/").trim_end_matches('/').to_string();
        if slug.is_empty() || slug.contains('/') { continue; }
        if !seen.insert(slug.clone()) { continue; }

        let date_label = a.select(&time_sel).next()
            .map(|t| collapse_ws(&t.text().collect::<String>()))
            .unwrap_or_default();
        if date_label.is_empty() { continue; }

        let category = a.select(&cat_sel).next()
            .map(|c| collapse_ws(&c.text().collect::<String>()))
            .filter(|s| !s.is_empty());

        // Take the first title-shaped element whose text isn't the category,
        // since `[class*="title"]` matches both "__title" (the article title)
        // and the category card's own wrapper in some layouts.
        let title = a.select(&title_sel)
            .map(|el| collapse_ws(&el.text().collect::<String>()))
            .find(|t| !t.is_empty() && Some(t) != category.as_ref())
            .unwrap_or_default();
        if title.is_empty() { continue; }

        let excerpt = a.select(&p_sel).next()
            .map(|p| collapse_ws(&p.text().collect::<String>()))
            .filter(|s| !s.is_empty() && Some(s) != category.as_ref() && s != &title);

        out.push(ScrapedItem {
            slug,
            url: format!("https://www.anthropic.com{href}"),
            title,
            category,
            excerpt,
            date_label,
        });
    }
    Ok(out)
}

pub async fn fetch_summary(article_url: &str) -> Result<Option<String>> {
    let body = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()?
        .get(article_url)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    Ok(parse_summary(&body))
}

/// Pulls Anthropic's own one-sentence TLDR from `<meta name="description">`.
/// Falls back to og:description, then twitter:description (all three are
/// always identical on anthropic.com today, but cheap to be robust).
pub fn parse_summary(html: &str) -> Option<String> {
    let doc = Html::parse_document(html);
    let candidates = [
        r#"meta[name="description"]"#,
        r#"meta[property="og:description"]"#,
        r#"meta[name="twitter:description"]"#,
    ];
    for q in candidates {
        let Ok(sel) = Selector::parse(q) else { continue };
        if let Some(content) = doc.select(&sel).next().and_then(|m| m.value().attr("content")) {
            let trimmed = content.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// "Apr 16, 2026" → "2026-04-16". Returns None for unparsable input.
pub fn parse_date_iso(label: &str) -> Option<String> {
    chrono::NaiveDate::parse_from_str(label.trim(), "%b %d, %Y")
        .ok()
        .map(|d| d.format("%Y-%m-%d").to_string())
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r##"
    <html><body>
    <a href="/news/claude-opus-4-7" class="FeaturedGrid-module__content">
      <h2 class="headline-4 FeaturedGrid-module__featuredTitle">Introducing Claude Opus 4.7</h2>
      <div class="FeaturedGrid-module__meta">
        <span class="caption bold">Product</span>
        <time class="FeaturedGrid-module__date">Apr 16, 2026</time>
      </div>
      <p class="body-3 serif FeaturedGrid-module__body">Stronger performance across coding.</p>
    </a>
    <a href="/news/finance-agents" class="PublicationList-module__listItem">
      <div class="PublicationList-module__meta">
        <time class="PublicationList-module__date body-3">May 5, 2026</time>
        <span class="PublicationList-module__subject body-3">Announcements</span>
      </div>
      <span class="PublicationList-module__title body-3">Agents for financial services</span>
    </a>
    <a href="/news/higher-limits-spacex" class="PublicationList-module__listItem">
      <div class="PublicationList-module__meta">
        <time class="PublicationList-module__date body-3">May 6, 2026</time>
        <span class="PublicationList-module__subject body-3">Announcements</span>
      </div>
      <span class="PublicationList-module__title body-3">Higher usage limits for Claude and a compute deal with SpaceX</span>
    </a>
    <a href="/news/claude-opus-4-7" class="dup">duplicate link</a>
    <a href="/news/">empty slug</a>
    <a href="/news/no-title-here"><time>Jan 1, 2026</time></a>
    </body></html>
    "##;

    #[test]
    fn parses_both_featured_grid_and_publication_list_variants() {
        let items = parse_index(FIXTURE).expect("parse");
        assert_eq!(items.len(), 3, "featured + 2 list items, dedupe + drop empty/no-title");

        let opus = items.iter().find(|i| i.slug == "claude-opus-4-7").expect("opus");
        assert_eq!(opus.title, "Introducing Claude Opus 4.7");
        assert_eq!(opus.category.as_deref(), Some("Product"));
        assert_eq!(opus.date_label, "Apr 16, 2026");
        assert_eq!(opus.excerpt.as_deref(), Some("Stronger performance across coding."));
        assert_eq!(opus.url, "https://www.anthropic.com/news/claude-opus-4-7");

        let finance = items.iter().find(|i| i.slug == "finance-agents").expect("list item");
        assert_eq!(finance.title, "Agents for financial services");
        assert_eq!(finance.category.as_deref(), Some("Announcements"));
        assert_eq!(finance.date_label, "May 5, 2026");

        let spacex = items.iter().find(|i| i.slug == "higher-limits-spacex").expect("list item 2");
        assert_eq!(spacex.title, "Higher usage limits for Claude and a compute deal with SpaceX");
    }

    #[test]
    fn extracts_meta_description_as_summary() {
        let html = r#"<html><head>
            <meta name="description" content="One-sentence TLDR.">
            <meta property="og:description" content="og fallback">
        </head></html>"#;
        assert_eq!(parse_summary(html).as_deref(), Some("One-sentence TLDR."));
    }

    #[test]
    fn summary_falls_back_to_og_description() {
        let html = r#"<html><head>
            <meta property="og:description" content="og fallback">
        </head></html>"#;
        assert_eq!(parse_summary(html).as_deref(), Some("og fallback"));
    }

    #[test]
    fn summary_returns_none_when_no_meta_description() {
        let html = r#"<html><head><title>x</title></head></html>"#;
        assert_eq!(parse_summary(html), None);
    }

    #[test]
    fn date_iso_handles_anthropic_format() {
        assert_eq!(parse_date_iso("Apr 16, 2026").as_deref(), Some("2026-04-16"));
        assert_eq!(parse_date_iso("Dec 3, 2025").as_deref(), Some("2025-12-03"));
        assert_eq!(parse_date_iso("garbage"), None);
    }
}
