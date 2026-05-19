use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Request {
    pub jsonrpc: String,
    pub id: Value,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Response {
    pub jsonrpc: String,
    pub id: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Notification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum Message {
    Request(Request),
    Response(Response),
    Notification(Notification),
}

impl RpcError {
    pub fn method_not_found(method: &str) -> Self {
        Self {
            code: -32601,
            message: format!("method not found: {method}"),
            data: None,
        }
    }
    pub fn internal(msg: impl Into<String>) -> Self {
        Self {
            code: -32603,
            message: msg.into(),
            data: None,
        }
    }
    pub fn invalid_params(msg: impl Into<String>) -> Self {
        Self {
            code: -32602,
            message: msg.into(),
            data: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_roundtrip() {
        let r = Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "health".into(),
            params: None,
        };
        let s = serde_json::to_value(&r).unwrap();
        assert_eq!(s, json!({"jsonrpc":"2.0","id":1,"method":"health"}));
        let back: Request = serde_json::from_value(s).unwrap();
        assert_eq!(back, r);
    }

    #[test]
    fn response_with_result_roundtrip() {
        let r = Response {
            jsonrpc: "2.0".into(),
            id: json!(1),
            result: Some(json!({"ok": true})),
            error: None,
        };
        let s = serde_json::to_value(&r).unwrap();
        let back: Response = serde_json::from_value(s).unwrap();
        assert_eq!(back, r);
    }

    #[test]
    fn response_with_error_roundtrip() {
        let r = Response {
            jsonrpc: "2.0".into(),
            id: json!(1),
            result: None,
            error: Some(RpcError::method_not_found("nope")),
        };
        let s = serde_json::to_value(&r).unwrap();
        let back: Response = serde_json::from_value(s).unwrap();
        assert_eq!(back, r);
    }

    #[test]
    fn message_untagged_distinguishes_request_vs_response() {
        let req_json = json!({"jsonrpc":"2.0","id":1,"method":"foo"});
        let resp_json = json!({"jsonrpc":"2.0","id":1,"result":42});
        let notif_json = json!({"jsonrpc":"2.0","method":"event"});

        match serde_json::from_value::<Message>(req_json).unwrap() {
            Message::Request(_) => {}
            other => panic!("expected Request, got {other:?}"),
        }
        match serde_json::from_value::<Message>(resp_json).unwrap() {
            Message::Response(_) => {}
            other => panic!("expected Response, got {other:?}"),
        }
        match serde_json::from_value::<Message>(notif_json).unwrap() {
            Message::Notification(_) => {}
            other => panic!("expected Notification, got {other:?}"),
        }
    }
}
