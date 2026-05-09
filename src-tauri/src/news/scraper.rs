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
    let h_sel = Selector::parse("h1, h2, h3, h4, h5, h6")
        .map_err(|e| anyhow!("h selector: {e:?}"))?;
    let time_sel = Selector::parse("time")
        .map_err(|e| anyhow!("time selector: {e:?}"))?;
    let cat_sel = Selector::parse("span.caption")
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

        let title = a.select(&h_sel).next()
            .map(|h| collapse_ws(&h.text().collect::<String>()))
            .unwrap_or_default();
        if title.is_empty() { continue; }

        let date_label = a.select(&time_sel).next()
            .map(|t| collapse_ws(&t.text().collect::<String>()))
            .unwrap_or_default();
        if date_label.is_empty() { continue; }

        let category = a.select(&cat_sel).next()
            .map(|c| collapse_ws(&c.text().collect::<String>()))
            .filter(|s| !s.is_empty());
        let excerpt = a.select(&p_sel).next()
            .map(|p| collapse_ws(&p.text().collect::<String>()))
            .filter(|s| !s.is_empty());

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

pub async fn fetch_og_image(article_url: &str) -> Result<Option<String>> {
    let body = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()?
        .get(article_url)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    Ok(parse_og_image(&body))
}

pub fn parse_og_image(html: &str) -> Option<String> {
    let doc = Html::parse_document(html);
    let sel = Selector::parse(r#"meta[property="og:image"]"#).ok()?;
    doc.select(&sel)
        .next()
        .and_then(|m| m.value().attr("content"))
        .map(|s| s.to_string())
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
    <a href="/news/claude-opus-4-7" class="content">
      <h2 class="headline-4">Introducing Claude Opus 4.7</h2>
      <div class="meta">
        <span class="caption bold">Product</span>
        <time class="date">Apr 16, 2026</time>
      </div>
      <p class="body-3 serif">Stronger performance across coding.</p>
    </a>
    <a href="/news/finance-agents" class="sideLink">
      <div class="meta"><span class="caption bold">Product</span><time>May 5, 2026</time></div>
      <h4 class="headline-6">Agents for finance</h4>
      <p class="body-3">Body here.</p>
    </a>
    <a href="/news/claude-opus-4-7" class="dup">duplicate link</a>
    <a href="/news/">empty slug</a>
    <a href="/news/no-title-here"><time>Jan 1, 2026</time></a>
    </body></html>
    "##;

    #[test]
    fn parses_articles_and_dedupes_slugs() {
        let items = parse_index(FIXTURE).expect("parse");
        assert_eq!(items.len(), 2, "dedupe by slug, drop empty/no-title");
        assert_eq!(items[0].slug, "claude-opus-4-7");
        assert_eq!(items[0].title, "Introducing Claude Opus 4.7");
        assert_eq!(items[0].category.as_deref(), Some("Product"));
        assert_eq!(items[0].date_label, "Apr 16, 2026");
        assert_eq!(items[0].excerpt.as_deref(), Some("Stronger performance across coding."));
        assert_eq!(items[0].url, "https://www.anthropic.com/news/claude-opus-4-7");
        assert_eq!(items[1].slug, "finance-agents");
    }

    #[test]
    fn extracts_og_image() {
        let html = r#"<html><head><meta property="og:image" content="https://cdn/x.png"/></head></html>"#;
        assert_eq!(parse_og_image(html).as_deref(), Some("https://cdn/x.png"));
    }

    #[test]
    fn date_iso_handles_anthropic_format() {
        assert_eq!(parse_date_iso("Apr 16, 2026").as_deref(), Some("2026-04-16"));
        assert_eq!(parse_date_iso("Dec 3, 2025").as_deref(), Some("2025-12-03"));
        assert_eq!(parse_date_iso("garbage"), None);
    }
}
