//! Fetches usage JSON from claude.ai using a stored sessionKey cookie.

use crate::types::UsageSnapshot;
use anyhow::{anyhow, Context, Result};
use serde::Deserialize;

const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

#[derive(Deserialize)]
struct OrgListEntry { uuid: String }

/// Errors that callers may want to react to distinctly.
#[derive(thiserror::Error, Debug)]
pub enum ScrapeError {
    #[error("unauthorized (session expired)")]
    Unauthorized,
    #[error("forbidden")]
    Forbidden,
    #[error("no organizations returned")]
    NoOrgs,
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

/// Fetches current usage. `base_url` is injected for tests; production passes
/// `"https://claude.ai"`.
pub async fn fetch_usage(base_url: &str, session_key: &str)
    -> Result<UsageSnapshot, ScrapeError>
{
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .context("building http client")
        .map_err(ScrapeError::Other)?;

    let cookie_header = format!("sessionKey={session_key}");

    // 1. Get organizations
    let orgs_url = format!("{base_url}/api/organizations");
    let orgs_resp = client.get(&orgs_url)
        .header("cookie", &cookie_header)
        .header("accept", "application/json")
        .header("referer", format!("{base_url}/settings/usage"))
        .send().await
        .context("GET /api/organizations")
        .map_err(ScrapeError::Other)?;

    let status = orgs_resp.status();
    if status.as_u16() == 401 { return Err(ScrapeError::Unauthorized); }
    if status.as_u16() == 403 { return Err(ScrapeError::Forbidden); }
    if !status.is_success() {
        return Err(ScrapeError::Other(anyhow!(
            "organizations HTTP {}",
            status.as_u16()
        )));
    }

    let orgs: Vec<OrgListEntry> = orgs_resp.json().await
        .context("parsing org list").map_err(ScrapeError::Other)?;
    let org_id = orgs.first().ok_or(ScrapeError::NoOrgs)?.uuid.clone();

    // 2. Get usage
    let usage_url = format!("{base_url}/api/organizations/{org_id}/usage");
    let usage_resp = client.get(&usage_url)
        .header("cookie", &cookie_header)
        .header("accept", "application/json")
        .header("referer", format!("{base_url}/settings/usage"))
        .send().await
        .context("GET usage").map_err(ScrapeError::Other)?;

    let status = usage_resp.status();
    if status.as_u16() == 401 { return Err(ScrapeError::Unauthorized); }
    if status.as_u16() == 403 { return Err(ScrapeError::Forbidden); }
    if !status.is_success() {
        return Err(ScrapeError::Other(anyhow!(
            "usage HTTP {}",
            status.as_u16()
        )));
    }

    // The API returns { five_hour, seven_day, extra_usage } without a
    // captured_at field; we stamp that ourselves.
    #[derive(Deserialize)]
    struct RawUsage {
        five_hour: crate::types::WindowUsage,
        seven_day: crate::types::WindowUsage,
        #[serde(default)]
        extra_usage: Option<crate::types::ExtraUsage>,
    }
    let raw: RawUsage = usage_resp.json().await
        .context("parsing usage").map_err(ScrapeError::Other)?;

    Ok(UsageSnapshot {
        captured_at: chrono::Utc::now().to_rfc3339(),
        five_hour: raw.five_hour,
        seven_day: raw.seven_day,
        extra_usage: raw.extra_usage,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn happy_path_returns_snapshot() {
        let mut server = mockito::Server::new_async().await;
        let _m1 = server.mock("GET", "/api/organizations")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"[{"uuid":"ORG-1"}]"#)
            .create_async().await;
        let _m2 = server.mock("GET", "/api/organizations/ORG-1/usage")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{
                "five_hour": {"utilization": 10.0, "resets_at": "x"},
                "seven_day": {"utilization": 5.0, "resets_at": "y"}
            }"#)
            .create_async().await;

        let snap = fetch_usage(&server.url(), "sk-abc").await.unwrap();
        assert_eq!(snap.five_hour.utilization, 10.0);
        assert_eq!(snap.seven_day.utilization, 5.0);
    }

    #[tokio::test]
    async fn unauthorized_on_401() {
        let mut server = mockito::Server::new_async().await;
        let _m = server.mock("GET", "/api/organizations")
            .with_status(401).create_async().await;
        let err = fetch_usage(&server.url(), "sk-bad").await.unwrap_err();
        assert!(matches!(err, ScrapeError::Unauthorized));
    }

    #[tokio::test]
    async fn no_orgs_returns_no_orgs_error() {
        let mut server = mockito::Server::new_async().await;
        let _m = server.mock("GET", "/api/organizations")
            .with_status(200).with_body("[]")
            .create_async().await;
        let err = fetch_usage(&server.url(), "sk").await.unwrap_err();
        assert!(matches!(err, ScrapeError::NoOrgs));
    }
}
