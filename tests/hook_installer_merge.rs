use claude_usage_tauri_lib::hook_installer::{merge_hooks, HookConfig};

#[test]
fn merges_into_empty_settings() {
    let existing = serde_json::json!({});
    let out = merge_hooks(&existing, &HookConfig { port: 27182 });
    assert_eq!(out["hooks"]["SessionStart"][0]["hooks"][0]["type"], "command");
    assert!(out["hooks"]["SessionStart"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap()
        .contains("27182"));
}

#[test]
fn preserves_existing_unrelated_fields() {
    let existing = serde_json::json!({
        "theme": "dark",
        "unrelated": { "key": "value" }
    });
    let out = merge_hooks(&existing, &HookConfig { port: 27182 });
    assert_eq!(out["theme"], "dark");
    assert_eq!(out["unrelated"]["key"], "value");
}

#[test]
fn preserves_existing_hooks_from_other_apps() {
    let existing = serde_json::json!({
        "hooks": {
            "SessionStart": [
                { "matcher": "other-app", "hooks": [{ "type": "command", "command": "other --run" }] }
            ]
        }
    });
    let out = merge_hooks(&existing, &HookConfig { port: 27182 });
    let arr = out["hooks"]["SessionStart"].as_array().unwrap();
    // Must keep the other-app entry, append ours.
    assert_eq!(arr.len(), 2);
    assert_eq!(arr[0]["matcher"], "other-app");
    assert_eq!(arr[1]["matcher"], "aiusage-taskbar");
}

#[test]
fn idempotent_when_our_entry_already_present() {
    let existing = serde_json::json!({});
    let once = merge_hooks(&existing, &HookConfig { port: 27182 });
    let twice = merge_hooks(&once, &HookConfig { port: 27182 });
    assert_eq!(once, twice);
}

#[test]
fn refreshes_our_command_when_port_changes() {
    let existing = serde_json::json!({});
    let v1 = merge_hooks(&existing, &HookConfig { port: 27182 });
    let v2 = merge_hooks(&v1, &HookConfig { port: 27200 });
    let arr = v2["hooks"]["SessionStart"].as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert!(arr[0]["hooks"][0]["command"].as_str().unwrap().contains("27200"));
}
