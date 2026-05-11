use claude_usage_tauri_lib::hooks::installer::{merge_hooks, HookConfig};

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
fn does_not_emit_matcher_on_session_events() {
    // SessionStart/SessionEnd treat `matcher` as a source filter
    // (startup|resume|clear|compact). Emitting an app-name literal silently
    // suppresses every firing, so we MUST leave the field out.
    let out = merge_hooks(&serde_json::json!({}), &HookConfig { port: 27182 });
    for event in ["SessionStart", "SessionEnd"] {
        let entry = &out["hooks"][event][0];
        assert!(
            entry.get("matcher").is_none(),
            "{event} entry must not carry a matcher field: {entry}",
        );
    }
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
    assert_eq!(arr.len(), 2);
    assert_eq!(arr[0]["matcher"], "other-app");
    // Ours is now identified by command substring, not matcher.
    let our_cmd = arr[1]["hooks"][0]["command"].as_str().unwrap();
    assert!(our_cmd.contains("/hooks/session-start"));
    assert!(our_cmd.contains("27182"));
}

#[test]
fn strips_legacy_matcher_entry_on_reinstall() {
    // v1 installs wrote `matcher: "aiusage-taskbar"` on SessionStart/End.
    // The migration must detect and replace those, not leave duplicates.
    let existing = serde_json::json!({
        "hooks": {
            "SessionStart": [
                { "matcher": "aiusage-taskbar", "hooks": [{
                    "type": "command",
                    "command": "curl http://127.0.0.1:27182/hooks/session-start"
                }]}
            ],
            "SessionEnd": [
                { "matcher": "aiusage-taskbar", "hooks": [{
                    "type": "command",
                    "command": "curl http://127.0.0.1:27182/hooks/session-end"
                }]}
            ]
        }
    });
    let out = merge_hooks(&existing, &HookConfig { port: 27182 });
    for event in ["SessionStart", "SessionEnd"] {
        let arr = out["hooks"][event].as_array().unwrap();
        assert_eq!(arr.len(), 1, "{event} should have exactly one entry after migration");
        assert!(arr[0].get("matcher").is_none(), "legacy matcher must be stripped");
    }
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

#[test]
fn merges_stop_hook() {
    let out = merge_hooks(&serde_json::json!({}), &HookConfig { port: 27182 });
    let entry = &out["hooks"]["Stop"][0];
    let cmd = entry["hooks"][0]["command"].as_str().unwrap();
    assert!(cmd.contains("/hooks/stop"), "expected stop endpoint in {cmd}");
    assert!(cmd.contains("27182"));
    assert!(
        entry.get("matcher").is_none(),
        "Stop hook matcher filters tool names; we want all, so leave it out"
    );
}

#[test]
fn stop_hook_replaces_old_stop_entry_on_reinstall() {
    let first = merge_hooks(&serde_json::json!({}), &HookConfig { port: 27182 });
    let second = merge_hooks(&first, &HookConfig { port: 27183 });
    let arr = second["hooks"]["Stop"].as_array().unwrap();
    assert_eq!(arr.len(), 1, "should not duplicate our own Stop entry");
    let cmd = arr[0]["hooks"][0]["command"].as_str().unwrap();
    assert!(cmd.contains("27183"));
}
