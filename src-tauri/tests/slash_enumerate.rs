use claude_usage_tauri_lib::slash::enumerate::scan_dirs;
use claude_usage_tauri_lib::slash::SlashSource;
use std::fs;

#[test]
fn scans_user_commands_skills_and_project_commands() {
    let home = tempfile::tempdir().unwrap();
    let proj = tempfile::tempdir().unwrap();

    fs::create_dir_all(home.path().join("commands")).unwrap();
    fs::write(
        home.path().join("commands/commit.md"),
        "---\ndescription: stage + commit\n---\nARGUMENTS: <flag>\nbody\n",
    )
    .unwrap();

    fs::create_dir_all(home.path().join("skills/foo")).unwrap();
    fs::write(
        home.path().join("skills/foo/SKILL.md"),
        "---\nname: foo\ndescription: do the foo thing\n---\nbody\n",
    )
    .unwrap();

    fs::create_dir_all(proj.path().join(".claude/commands")).unwrap();
    fs::write(
        proj.path().join(".claude/commands/local.md"),
        "---\ndescription: project-scoped\n---\nbody\n",
    )
    .unwrap();

    let out = scan_dirs(home.path(), Some(proj.path()));

    let has = |name: &str, want_source: &dyn Fn(&SlashSource) -> bool| {
        out.iter().any(|e| e.name == name && want_source(&e.source))
    };

    assert!(has("commit", &|s| matches!(s, SlashSource::UserCommand)));
    assert!(has("foo", &|s| matches!(s, SlashSource::UserSkill)));
    assert!(has("local", &|s| matches!(s, SlashSource::ProjectCommand)));

    let commit = out.iter().find(|e| e.name == "commit").unwrap();
    assert_eq!(commit.description, "stage + commit");
    assert_eq!(commit.args.as_deref(), Some("<flag>"));
}

#[test]
fn scans_plugin_skills_and_commands() {
    let home = tempfile::tempdir().unwrap();

    let plugin_skill_dir = home.path().join("plugins/cache/myplugin/abc123/skills/foo");
    fs::create_dir_all(&plugin_skill_dir).unwrap();
    fs::write(
        plugin_skill_dir.join("SKILL.md"),
        "---\nname: foo\ndescription: plugin skill\n---\n",
    )
    .unwrap();

    let plugin_cmd_dir = home.path().join("plugins/cache/myplugin/abc123/commands");
    fs::create_dir_all(&plugin_cmd_dir).unwrap();
    fs::write(
        plugin_cmd_dir.join("bar.md"),
        "---\ndescription: plugin command\n---\nbody\n",
    )
    .unwrap();

    let out = scan_dirs(home.path(), None);

    let plugin_skill = out.iter().find(|e| e.name == "foo").unwrap();
    match &plugin_skill.source {
        SlashSource::PluginSkill { plugin } => assert_eq!(plugin, "myplugin"),
        _ => panic!("expected PluginSkill, got {:?}", plugin_skill.source),
    }

    let plugin_cmd = out.iter().find(|e| e.name == "bar").unwrap();
    match &plugin_cmd.source {
        SlashSource::PluginCommand { plugin } => assert_eq!(plugin, "myplugin"),
        _ => panic!("expected PluginCommand, got {:?}", plugin_cmd.source),
    }
}

#[test]
fn includes_builtins() {
    let home = tempfile::tempdir().unwrap();
    let out = scan_dirs(home.path(), None);
    assert!(out.iter().any(|e| e.name == "help" && matches!(e.source, SlashSource::Builtin)));
    assert!(out.iter().any(|e| e.name == "clear"));
}

#[test]
fn missing_dirs_are_swallowed() {
    let home = tempfile::tempdir().unwrap();
    let out = scan_dirs(home.path(), None);
    assert!(!out.is_empty(), "should at least return builtins");
}
