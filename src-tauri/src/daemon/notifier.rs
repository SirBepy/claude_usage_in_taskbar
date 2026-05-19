//! Daemon-wide notification broadcaster. Anything that is not bound to a
//! specific chat session (instance changes, permission requests, project
//! creations, token history updates) fans out through here. Per-connection
//! notification tasks gate forwarding behind the `global_sub` flag.

use serde_json::Value;
use tokio::sync::broadcast;

pub const GLOBAL_BROADCAST_CAPACITY: usize = 512;

#[derive(Clone)]
pub struct Notifier {
    tx: broadcast::Sender<Value>,
}

impl Notifier {
    pub fn new() -> Self {
        let (tx, _rx) = broadcast::channel(GLOBAL_BROADCAST_CAPACITY);
        Self { tx }
    }

    /// Sends a JSON-RPC 2.0 notification (`{jsonrpc, method, params}`) to all
    /// attached global subscribers. Returns the number of receivers that
    /// successfully observed the notification (0 if none).
    pub fn publish(&self, method: &str, params: Value) -> usize {
        let frame = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        self.tx.send(frame).unwrap_or(0)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.tx.subscribe()
    }
}

impl Default for Notifier {
    fn default() -> Self { Self::new() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn publish_to_no_subscribers_returns_zero() {
        let n = Notifier::new();
        assert_eq!(n.publish("test", json!({})), 0);
    }

    #[tokio::test]
    async fn subscriber_receives_published_notification() {
        let n = Notifier::new();
        let mut rx = n.subscribe();
        let count = n.publish("foo", json!({"x": 1}));
        assert_eq!(count, 1);
        let v = rx.recv().await.expect("recv");
        assert_eq!(v["method"], json!("foo"));
        assert_eq!(v["params"]["x"], json!(1));
    }
}
