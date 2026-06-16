//! stdio MCP server mode. Entered when the binary is spawned with
//! `--mcp-permission`. Implements MCP JSON-RPC 2.0 over stdin/stdout
//! (one JSON object per line). Exposes two tools:
//!   - `approval_prompt`: used as `--permission-prompt-tool` by the runner
//!   - `ask_user_question`: lets claude ask the user a question mid-turn
//!
//! HTTP coordination piggybacks on the existing hooks server.

use serde_json::{json, Value};
use std::io::{BufRead, Write};

const TOOL_APPROVAL: &str = "approval_prompt";
const TOOL_QUESTION: &str = "ask_user_question";

/// Read the hooks port from <app-data>/hooks_port.txt.
fn read_port() -> Option<u16> {
    crate::settings::paths::read_hook_port("")
}

/// HTTP POST helper (blocking via tokio runtime).
/// Overall cap on a single relay POST. The daemon hooks server holds a
/// permission/question prompt open for up to `PROMPT_TIMEOUT_SECS` (3600s, see
/// `daemon::hooks_server::permission`) so an AFK dev can answer later, then
/// always returns an answer or a graceful deny. This client MUST out-wait that
/// window, otherwise it aborts mid-prompt with "error sending request" and the
/// dev's eventual answer is dropped. 3600 + 60s slack so the server's response
/// always lands first; still bounded so a truly-wedged server can't hang the
/// MCP process forever.
const RELAY_TIMEOUT_SECS: u64 = 3660;

fn http_post(rt: &tokio::runtime::Runtime, url: &str, body: Value) -> Result<Value, String> {
    rt.block_on(async {
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(RELAY_TIMEOUT_SECS))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        resp.json::<Value>().await.map_err(|e| e.to_string())
    })
}

fn tool_list_response(id: &Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "tools": [
                {
                    "name": TOOL_APPROVAL,
                    "description": "Request user permission for a tool invocation. Returns {behavior: 'allow'|'deny'}.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "tool_name": {"type": "string", "description": "Name of the tool needing permission"},
                            "input": {"type": "object", "description": "Input that will be passed to the tool"}
                        },
                        "required": ["tool_name", "input"]
                    }
                },
                {
                    "name": TOOL_QUESTION,
                    "description": "Ask the user one or more questions and get their answers.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "questions": {
                                "type": "array",
                                "description": "Questions to ask",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "question": {"type": "string"},
                                        "options": {
                                            "type": "array",
                                            "items": {
                                                "type": "object",
                                                "properties": {
                                                    "label": {"type": "string"},
                                                    "description": {"type": "string"}
                                                }
                                            }
                                        }
                                    },
                                    "required": ["question"]
                                }
                            }
                        },
                        "required": ["questions"]
                    }
                }
            ]
        }
    })
}

fn mcp_error(id: &Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {"code": code, "message": message}
    })
}

fn tool_result(id: &Value, text: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "content": [{"type": "text", "text": text}],
            "isError": false
        }
    })
}

fn tool_error_result(id: &Value, text: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "content": [{"type": "text", "text": text}],
            "isError": true
        }
    })
}

pub fn run_stdio() {
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("mcp: failed to build runtime: {e}");
            return;
        }
    };

    let port = match read_port() {
        Some(p) => p,
        None => {
            eprintln!("mcp: could not read hooks_port.txt; permission relay unavailable");
            // Still serve the protocol so claude doesn't crash, but tool calls
            // will return errors.
            0
        }
    };

    let session_id = std::env::var("CC_SESSION_ID").unwrap_or_default();

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let method = req["method"].as_str().unwrap_or("");

        let response = match method {
            "initialize" => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "cc_companion", "version": "0.1.0"}
                }
            }),
            "notifications/initialized" => continue,
            "tools/list" => tool_list_response(&id),
            "tools/call" => {
                let name = req["params"]["name"].as_str().unwrap_or("");
                let arguments = req["params"]["arguments"].clone();

                if port == 0 {
                    tool_error_result(&id, "hooks server port unavailable")
                } else {
                    let request_id = uuid::Uuid::new_v4().to_string();
                    match name {
                        TOOL_APPROVAL => {
                            let tool_name = arguments["tool_name"]
                                .as_str()
                                .unwrap_or("unknown")
                                .to_string();
                            let input = arguments["input"].clone();
                            let url = format!("http://127.0.0.1:{port}/permissions/request");
                            let body = json!({
                                "id": request_id,
                                "tool_name": tool_name,
                                "input": input,
                                "session_id": session_id,
                            });
                            match http_post(&rt, &url, body) {
                                Ok(resp) => tool_result(&id, &resp.to_string()),
                                Err(e) => tool_error_result(&id, &format!("relay error: {e}")),
                            }
                        }
                        TOOL_QUESTION => {
                            let questions = arguments["questions"].clone();
                            let url = format!("http://127.0.0.1:{port}/questions/request");
                            let body = json!({
                                "id": request_id,
                                "questions": questions,
                                "session_id": session_id,
                            });
                            match http_post(&rt, &url, body) {
                                Ok(resp) => tool_result(&id, &resp.to_string()),
                                Err(e) => tool_error_result(&id, &format!("relay error: {e}")),
                            }
                        }
                        _ => mcp_error(&id, -32601, "unknown tool"),
                    }
                }
            }
            _ => {
                // Unknown method: return method-not-found only for requests (have id).
                if id != Value::Null {
                    mcp_error(&id, -32601, "method not found")
                } else {
                    continue;
                }
            }
        };

        let line_out = match serde_json::to_string(&response) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let _ = writeln!(out, "{line_out}");
        let _ = out.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dispatch(req: &str, port: u16, session_id: &str) -> Value {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let req: Value = serde_json::from_str(req).unwrap();
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let method = req["method"].as_str().unwrap_or("");

        match method {
            "initialize" => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "cc_companion", "version": "0.1.0"}
                }
            }),
            "tools/list" => tool_list_response(&id),
            "tools/call" => {
                let name = req["params"]["name"].as_str().unwrap_or("");
                let _ = req["params"]["arguments"].clone();
                if port == 0 {
                    tool_error_result(&id, "hooks server port unavailable")
                } else {
                    // In unit tests we don't actually make HTTP calls.
                    tool_error_result(&id, "test-no-http")
                }
            }
            _ => mcp_error(&id, -32601, "method not found"),
        }
    }

    #[test]
    fn initialize_returns_server_info() {
        let resp = dispatch(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
            27182,
            "",
        );
        assert_eq!(resp["result"]["serverInfo"]["name"], "cc_companion");
        assert_eq!(resp["result"]["protocolVersion"], "2024-11-05");
    }

    #[test]
    fn tools_list_returns_two_tools() {
        let resp = dispatch(
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#,
            27182,
            "",
        );
        let tools = resp["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 2);
        let names: Vec<&str> = tools.iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert!(names.contains(&"approval_prompt"));
        assert!(names.contains(&"ask_user_question"));
    }

    #[test]
    fn tools_call_unknown_tool_returns_error() {
        let resp = dispatch(
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"nonexistent","arguments":{}}}"#,
            0,
            "",
        );
        // port=0 → unavailable error
        assert_eq!(resp["result"]["isError"], true);
    }

    #[test]
    fn unknown_method_returns_method_not_found() {
        let resp = dispatch(
            r#"{"jsonrpc":"2.0","id":4,"method":"bogus","params":{}}"#,
            27182,
            "",
        );
        assert_eq!(resp["error"]["code"], -32601);
    }
}
