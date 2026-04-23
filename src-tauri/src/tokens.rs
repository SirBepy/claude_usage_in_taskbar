pub mod record;
pub mod walker;
pub mod aggregate;
pub mod backfill;
pub mod live;

pub use record::*;
pub use walker::*;
pub use aggregate::*;
pub use backfill::*;
pub use live::*;

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::path::Path;
    use tempfile::tempdir;

    #[test]
    fn walk_jsonl_finds_nested_files() {
        let dir = tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("a/b")).unwrap();
        std::fs::write(dir.path().join("a/one.jsonl"), "").unwrap();
        std::fs::write(dir.path().join("a/b/two.jsonl"), "").unwrap();
        std::fs::write(dir.path().join("a/ignore.txt"), "").unwrap();
        let mut found = walk_jsonl(dir.path());
        found.sort();
        assert_eq!(found.len(), 2);
        assert!(found[0].ends_with("one.jsonl") || found[1].ends_with("one.jsonl"));
    }

    #[test]
    fn encode_cwd_matches_claude_cli_layout() {
        use std::path::Path;
        assert_eq!(
            encode_cwd_as_project_dir(Path::new("c:\\Users\\tecno\\Desktop\\Projects\\claude_usage_in_taskbar")),
            "c--Users-tecno-Desktop-Projects-claude-usage-in-taskbar",
        );
        assert_eq!(
            encode_cwd_as_project_dir(Path::new("C:\\Users\\tecno\\.claude")),
            "C--Users-tecno--claude",
        );
    }

    #[test]
    fn latest_transcript_for_cwd_returns_none_when_dir_missing() {
        use std::path::Path;
        let out = latest_transcript_for_cwd(Path::new("Z:\\does\\not\\exist"));
        assert!(out.is_none());
    }

    #[test]
    fn parse_transcript_sums_assistant_usages() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let content = [
            r#"{"type":"user","message":{"content":"hi"}}"#,
            r#"{"type":"assistant","message":{"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":5,"cache_creation_input_tokens":3}}}"#,
            r#""#,
            r#"{"type":"assistant","usage":{"input_tokens":100,"output_tokens":50}}"#,
            r#"not json at all"#,
        ].join("\n");
        std::fs::write(&path, content).unwrap();
        let totals = parse_transcript(&path);
        assert_eq!(totals.input_tokens, 110);
        assert_eq!(totals.output_tokens, 70);
        assert_eq!(totals.cache_read_tokens, 5);
        assert_eq!(totals.cache_creation_tokens, 3);
        assert_eq!(totals.turns, 2);
    }

    #[test]
    fn parse_transcript_missing_file_returns_zero() {
        let totals = parse_transcript(Path::new("definitely-not-a-real-file.jsonl"));
        assert_eq!(totals.turns, 0);
        assert_eq!(totals.input_tokens, 0);
    }

    #[test]
    fn load_save_history_roundtrips() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("token-history.json");
        let rec = TokenRecord {
            session_id: "S1".into(),
            cwd: Some("C:\\proj".into()),
            date: "2026-04-20".into(),
            input_tokens: 1,
            output_tokens: 2,
            cache_read_tokens: 3,
            cache_creation_tokens: 4,
            turns: 5,
            started_at: "2026-04-20T10:00:00Z".into(),
            last_active_at: "2026-04-20T10:30:00Z".into(),
            recorded_at: "2026-04-20T10:31:00Z".into(),
            live: None,
            merged_subagents: None,
        };
        save_history(&path, std::slice::from_ref(&rec)).unwrap();
        let back = load_history(&path);
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].session_id, "S1");
        assert_eq!(back[0].turns, 5);
    }

    #[test]
    fn load_history_returns_empty_for_missing_or_corrupt() {
        let dir = tempdir().unwrap();
        let missing = dir.path().join("nope.json");
        assert!(load_history(&missing).is_empty());

        let corrupt = dir.path().join("c.json");
        std::fs::write(&corrupt, "{ this is not valid json").unwrap();
        assert!(load_history(&corrupt).is_empty());
    }

    #[test]
    fn append_session_is_idempotent_on_session_id() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("h.json");
        let rec = TokenRecord {
            session_id: "S1".into(),
            date: "2026-04-20".into(),
            input_tokens: 1,
            ..Default::default()
        };
        append_session(&path, rec.clone()).unwrap();
        append_session(&path, rec.clone()).unwrap();
        let h = load_history(&path);
        assert_eq!(h.len(), 1, "duplicate append should be a no-op");
    }

    /// A `backfill_all`-style helper that takes an explicit projects dir so
    /// we can unit-test the aggregation without reaching out to `~/.claude`.
    fn backfill_from(projects_dir: &Path, history_path: &Path) -> BackfillResult {
        let files = walk_jsonl(projects_dir);
        let mut regular = Vec::new();
        let mut subagent = Vec::new();
        for p in files {
            let in_sub = p.parent().and_then(|d| d.file_name()).and_then(|n| n.to_str())
                == Some("subagents");
            if in_sub { subagent.push(p) } else { regular.push(p) }
        }

        let mut history = load_history(history_path);
        let mut known: HashSet<String> = history.iter().map(|r| r.session_id.clone()).collect();
        let mut result = BackfillResult::default();

        for file in &regular {
            let sid = file.file_stem().and_then(|s| s.to_str()).unwrap().to_string();
            if known.contains(&sid) { result.skipped += 1; continue }
            let totals = parse_transcript(file);
            history.push(TokenRecord {
                session_id: sid.clone(),
                cwd: Some("C:\\fake".into()),
                date: "2026-04-20".into(),
                input_tokens: totals.input_tokens,
                output_tokens: totals.output_tokens,
                cache_read_tokens: totals.cache_read_tokens,
                cache_creation_tokens: totals.cache_creation_tokens,
                turns: totals.turns,
                started_at: "2026-04-20T10:00:00Z".into(),
                last_active_at: "2026-04-20T10:30:00Z".into(),
                recorded_at: "2026-04-20T10:31:00Z".into(),
                live: None,
                merged_subagents: None,
            });
            known.insert(sid);
            result.processed += 1;
        }

        let mut merged_ids: HashSet<String> = HashSet::new();
        for r in &history {
            if let Some(l) = &r.merged_subagents { for id in l { merged_ids.insert(id.clone()); } }
        }
        for file in &subagent {
            let agent_id = file.file_stem().and_then(|s| s.to_str()).unwrap().to_string();
            if merged_ids.contains(&agent_id) { result.sub_skipped += 1; continue }
            let parent_sid = file
                .parent().and_then(|d| d.parent())
                .and_then(|d| d.file_name()).and_then(|n| n.to_str()).unwrap().to_string();
            let totals = parse_transcript(file);
            let idx = history.iter().position(|r| r.session_id == parent_sid);
            let idx = idx.unwrap_or_else(|| {
                history.push(TokenRecord {
                    session_id: parent_sid.clone(),
                    cwd: Some("C:\\fake".into()),
                    date: "2026-04-20".into(),
                    started_at: "2026-04-20T09:00:00Z".into(),
                    last_active_at: "2026-04-20T09:00:00Z".into(),
                    recorded_at: "2026-04-20T09:00:00Z".into(),
                    merged_subagents: Some(Vec::new()),
                    ..Default::default()
                });
                history.len() - 1
            });
            let p = &mut history[idx];
            p.input_tokens += totals.input_tokens;
            p.output_tokens += totals.output_tokens;
            p.cache_read_tokens += totals.cache_read_tokens;
            p.cache_creation_tokens += totals.cache_creation_tokens;
            p.turns += totals.turns;
            p.merged_subagents.get_or_insert_with(Vec::new).push(agent_id.clone());
            merged_ids.insert(agent_id);
            result.sub_processed += 1;
        }

        save_history(history_path, &history).unwrap();
        result
    }

    #[test]
    fn backfill_aggregates_and_merges_subagents() {
        let dir = tempdir().unwrap();
        let projects = dir.path().join("projects");
        let history_path = dir.path().join("token-history.json");

        let proj_a = projects.join("proj-a");
        std::fs::create_dir_all(&proj_a).unwrap();
        std::fs::write(
            proj_a.join("SESSION-1.jsonl"),
            r#"{"type":"assistant","message":{"usage":{"input_tokens":10,"output_tokens":20}}}"#,
        ).unwrap();

        let sub_dir = proj_a.join("SESSION-1").join("subagents");
        std::fs::create_dir_all(&sub_dir).unwrap();
        std::fs::write(
            sub_dir.join("AGENT-X.jsonl"),
            r#"{"type":"assistant","message":{"usage":{"input_tokens":5,"output_tokens":1}}}"#,
        ).unwrap();

        let r = backfill_from(&projects, &history_path);
        assert_eq!(r.processed, 1);
        assert_eq!(r.sub_processed, 1);

        let history = load_history(&history_path);
        assert_eq!(history.len(), 1, "subagent should be merged into parent");
        let s1 = history.iter().find(|r| r.session_id == "SESSION-1").unwrap();
        assert_eq!(s1.input_tokens, 15, "10 (main) + 5 (sub) input tokens");
        assert_eq!(s1.output_tokens, 21, "20 (main) + 1 (sub) output tokens");
        assert_eq!(s1.merged_subagents.as_ref().unwrap(), &vec!["AGENT-X".to_string()]);

        let r2 = backfill_from(&projects, &history_path);
        assert_eq!(r2.processed, 0);
        assert_eq!(r2.skipped, 1);
        assert_eq!(r2.sub_processed, 0);
        assert_eq!(r2.sub_skipped, 1);
        let history2 = load_history(&history_path);
        assert_eq!(history2.len(), 1, "re-backfill must not duplicate");
        let s1b = history2.iter().find(|r| r.session_id == "SESSION-1").unwrap();
        assert_eq!(s1b.input_tokens, 15, "tokens stable across re-backfill");
    }

    #[test]
    fn decode_cwd_returns_original_when_no_drive_marker_on_windows() {
        if cfg!(windows) {
            assert_eq!(decode_cwd("just-some-name"), "just-some-name");
        }
    }
}
