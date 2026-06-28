use claude_conductor_lib::files::scan;
use std::fs;
use std::process::Command;

fn git(dir: &std::path::Path, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn lists_tracked_and_untracked_excludes_ignored() {
    let tmp = tempfile::tempdir().unwrap();
    let p = tmp.path();
    git(p, &["init", "-q"]);
    git(p, &["config", "user.email", "t@t"]);
    git(p, &["config", "user.name", "t"]);
    fs::write(p.join(".gitignore"), "ignored.txt\n").unwrap();
    fs::write(p.join("tracked.txt"), "a").unwrap();
    git(p, &["add", "tracked.txt", ".gitignore"]);
    git(p, &["commit", "-q", "-m", "init"]);
    fs::write(p.join("untracked.txt"), "b").unwrap();
    fs::write(p.join("ignored.txt"), "c").unwrap();

    let paths = scan(p).unwrap();
    assert!(paths.iter().any(|s| s == "tracked.txt"), "missing tracked: {paths:?}");
    assert!(paths.iter().any(|s| s == "untracked.txt"), "missing untracked: {paths:?}");
    assert!(!paths.iter().any(|s| s == "ignored.txt"), "ignored present: {paths:?}");
}

#[test]
fn non_git_dir_returns_empty() {
    let tmp = tempfile::tempdir().unwrap();
    fs::write(tmp.path().join("plain.txt"), "a").unwrap();
    let paths = scan(tmp.path()).unwrap();
    assert!(paths.is_empty(), "got: {paths:?}");
}

#[test]
fn nonexistent_dir_returns_empty() {
    let p = std::path::PathBuf::from("/nonexistent-xyz-12345");
    assert!(scan(&p).unwrap().is_empty());
}
