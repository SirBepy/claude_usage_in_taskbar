use crate::daemon::rpc::Router;
use serde_json::json;

pub const PROTOCOL_VERSION: u32 = 1;
pub const DAEMON_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn register(router: &mut Router) {
    router.register("health", |_params, _ctx| async move {
        Ok(json!({
            "daemon_version": DAEMON_VERSION,
            "protocol_version": PROTOCOL_VERSION,
        }))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::rpc::{ConnectionContext, Request};

    fn dummy_ctx() -> ConnectionContext {
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        ConnectionContext::new(tx)
    }

    #[tokio::test]
    async fn health_returns_versions() {
        let mut r = Router::new();
        register(&mut r);
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "health".into(),
            params: None,
        }, dummy_ctx()).await;
        let result = resp.result.expect("result");
        assert_eq!(result["protocol_version"], json!(PROTOCOL_VERSION));
        assert_eq!(result["daemon_version"], json!(DAEMON_VERSION));
    }
}
