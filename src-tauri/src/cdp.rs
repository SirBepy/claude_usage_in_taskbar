//! Minimal Chrome DevTools Protocol client used only to pull cookies after
//! login. We speak one method at a time, reconnecting for each call to avoid
//! managing concurrency.

use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message};

/// Calls a single CDP method and returns the `result` field.
/// `ws_url` must be the full `ws://127.0.0.1:<port>/devtools/browser/...` URL
/// returned by Chrome's `/json/version` endpoint.
pub async fn call(ws_url: &str, method: &str, params: Value, timeout: Duration)
    -> Result<Value>
{
    let id: u64 = rand::thread_rng().gen_range(1..1_000_000);
    let payload = json!({ "id": id, "method": method, "params": params });

    let (mut ws, _) = connect_async(ws_url).await
        .with_context(|| format!("connect CDP ws {ws_url}"))?;
    ws.send(Message::Text(payload.to_string())).await
        .context("send CDP request")?;

    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(anyhow!("CDP {method} timed out"));
        }
        let msg = match tokio::time::timeout(remaining, ws.next()).await {
            Ok(Some(Ok(m))) => m,
            Ok(Some(Err(e))) => return Err(e).context("CDP ws recv"),
            Ok(None) => return Err(anyhow!("CDP ws closed before response")),
            Err(_) => return Err(anyhow!("CDP {method} timed out")),
        };
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => return Err(anyhow!("CDP ws closed")),
            _ => continue,
        };
        let v: Value = serde_json::from_str(&text).context("parse CDP msg")?;
        if v.get("id").and_then(|x| x.as_u64()) == Some(id) {
            if let Some(err) = v.get("error") {
                return Err(anyhow!("CDP error: {err}"));
            }
            let result = v.get("result").cloned().unwrap_or(Value::Null);
            let _ = ws.close(None).await;
            return Ok(result);
        }
        // else: some other event (e.g. target created), ignore
    }
}

/// Fetches the browser-level debugger websocket URL from Chrome's HTTP endpoint.
pub async fn browser_ws_url(http_endpoint: &str) -> Result<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()?;
    let resp = client.get(format!("{http_endpoint}/json/version")).send().await
        .context("fetch /json/version")?;
    let v: Value = resp.json().await.context("parse /json/version")?;
    v.get("webSocketDebuggerUrl").and_then(|x| x.as_str())
        .map(str::to_string)
        .ok_or_else(|| anyhow!("no webSocketDebuggerUrl in /json/version"))
}
