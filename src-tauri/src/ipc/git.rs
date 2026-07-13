//! Git info IPC: branch/repo/ahead-behind/dirty status + the daemon-aligned
//! context-window status (which resolves a transcript on local disk). Split out
//! of `misc.rs` so each module keeps a single responsibility.

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct GitInfo {
    pub branch: Option<String>,
    pub repo: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub sha: Option<String>,
    pub insertions: Option<u32>,
    pub deletions: Option<u32>,
}

/// Parse `git diff --shortstat` output into (insertions, deletions). Empty
/// output (clean tree) => (None, None); a present line with only one side =>
/// the missing side is 0.
pub fn parse_shortstat(s: &str) -> (Option<u32>, Option<u32>) {
    let s = s.trim();
    if s.is_empty() {
        return (None, None);
    }
    let grab = |needle: &str| -> Option<u32> {
        let idx = s.find(needle)?;
        s[..idx]
            .rsplit(|c: char| !c.is_ascii_digit())
            .find(|p| !p.is_empty())
            .and_then(|p| p.parse().ok())
    };
    (Some(grab("insertion").unwrap_or(0)), Some(grab("deletion").unwrap_or(0)))
}

/// Daemon-aligned context-window status for a session. The transcript lives on
/// local disk, so the app resolves it itself (cwd from the mirrored instance
/// cache, else a project-dir scan) and runs the same core scorer the daemon's
/// `/context` endpoint uses. This is the least-coupled option: no daemon RPC,
/// one shared `compute_context_status` for both surfaces. Returns None when the
/// transcript can't be resolved or carries no usage lines.
#[tauri::command]
pub async fn context_status(
    session_id: String,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<Option<crate::context_status::ContextStatus>, String> {
    use crate::tokens::walker;

    // Resolve the transcript path from the app's mirrored instance cache. The
    // daemon registry isn't directly reachable here; `cached_instances` is the
    // app-side mirror refreshed via `instances_changed`.
    let resolved: Option<std::path::PathBuf> = {
        let instances = state.cached_instances.lock().unwrap();
        instances
            .iter()
            .find(|i| i.session_id == session_id)
            .and_then(|inst| {
                inst.transcript_path
                    .as_ref()
                    .filter(|p| p.exists())
                    .cloned()
                    .or_else(|| walker::transcript_for_session(&inst.cwd, &session_id))
            })
    };

    let status = tauri::async_runtime::spawn_blocking(move || {
        if let Some(path) = resolved {
            return crate::context_status::compute_context_status(&path);
        }
        // Fallback: scan ~/.claude/projects/*/<session_id>.jsonl directly.
        let projects = walker::claude_projects_dir()?;
        let target = format!("{session_id}.jsonl");
        let entries = std::fs::read_dir(&projects).ok()?;
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let candidate = dir.join(&target);
            if candidate.exists() {
                return crate::context_status::compute_context_status(&candidate);
            }
        }
        None
    })
    .await
    .map_err(|e| format!("context_status join error: {e}"))?;

    Ok(status)
}

/// Returns the list of files with uncommitted changes in the given directory.
/// Used to detect whether there is work to commit before closing a chat session.
/// Returns an empty vec if the directory is not a git repo or git is unavailable.
#[tauri::command]
pub async fn get_git_dirty(cwd: String) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = std::process::Command::new("git");
        cmd.arg("-C").arg(&cwd).args(["status", "--porcelain"]);
        crate::util::process::hide_console(&mut cmd);
        cmd.output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| {
                s.lines()
                    .filter(|l| l.len() > 3)
                    .map(|l| l[3..].trim().to_string())
                    .filter(|p| !p.is_empty())
                    .collect()
            })
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

/// Returns the current git branch and repository name for the given working
/// directory. Used by the session statusbar to show branch + repo context.
/// Never fails - missing git / no repo / no remote all produce None fields.
///
/// Runs on the blocking pool: spawning `git` is real process IO which
/// must NOT happen on the Tauri runtime thread or the webview UI hangs
/// for the duration of the spawn. On Windows the spawned `git.exe` is
/// flagged CREATE_NO_WINDOW to suppress the otherwise-visible console
/// flash on every chat open.
#[tauri::command]
pub async fn get_git_info(cwd: String) -> GitInfo {
    tauri::async_runtime::spawn_blocking(move || {
        fn run_git(cwd: &str, args: &[&str]) -> Option<String> {
            let mut cmd = std::process::Command::new("git");
            cmd.arg("-C").arg(cwd).args(args);
            crate::util::process::hide_console(&mut cmd);
            cmd.output()
                .ok()
                .filter(|o| o.status.success())
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        }

        let branch = run_git(&cwd, &["branch", "--show-current"]);

        let remote_url = run_git(&cwd, &["remote", "get-url", "origin"]);
        let repo = if let Some(url) = &remote_url {
            url.split('/')
                .last()
                .map(|s| s.trim_end_matches(".git").to_string())
                .filter(|s| !s.is_empty())
        } else {
            std::path::Path::new(&cwd)
                .file_name()
                .and_then(|s| s.to_str())
                .map(|s| s.to_string())
        };

        // Upstream ahead/behind: `behind<TAB>ahead`. None when no upstream.
        let (ahead, behind) = run_git(&cwd, &["rev-list", "--left-right", "--count", "@{u}...HEAD"])
            .and_then(|s| {
                let mut it = s.split_whitespace();
                let behind = it.next()?.parse::<u32>().ok()?;
                let ahead = it.next()?.parse::<u32>().ok()?;
                Some((Some(ahead), Some(behind)))
            })
            .unwrap_or((None, None));

        let sha = run_git(&cwd, &["rev-parse", "--short", "HEAD"]);

        let (insertions, deletions) = run_git(&cwd, &["diff", "--shortstat"])
            .map(|s| parse_shortstat(&s))
            .unwrap_or((None, None));

        GitInfo { branch, repo, ahead, behind, sha, insertions, deletions }
    })
    .await
    .unwrap_or(GitInfo { branch: None, repo: None, ahead: None, behind: None, sha: None, insertions: None, deletions: None })
}

#[derive(serde::Serialize)]
pub struct BranchEntry {
    pub name: String,
    pub current: bool,
    pub short_sha: Option<String>,
    pub upstream: Option<String>,
}

#[derive(serde::Serialize)]
pub struct CommitEntry {
    pub short_sha: String,
    pub message: String,
}

#[derive(serde::Serialize)]
pub struct CommitSync {
    pub ahead: Vec<CommitEntry>,
    pub behind: Vec<CommitEntry>,
    pub has_upstream: bool,
}

/// Returns recent local branches sorted by last commit date (most recent first),
/// up to 15. Each entry carries the current-branch marker, short SHA, and
/// tracking upstream ref if configured.
#[tauri::command]
pub async fn get_recent_branches(cwd: String) -> Vec<BranchEntry> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = std::process::Command::new("git");
        cmd.arg("-C").arg(&cwd).args([
            "branch",
            "--sort=-committerdate",
            "--format=%(HEAD)|%(refname:short)|%(objectname:short)|%(upstream:short)",
        ]);
        crate::util::process::hide_console(&mut cmd);
        let out = cmd
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .unwrap_or_default();
        out.lines()
            .take(15)
            .filter_map(|line| {
                let mut parts = line.splitn(4, '|');
                let head = parts.next()?;
                let name = parts.next()?.trim().to_string();
                if name.is_empty() { return None; }
                let short_sha = parts.next().map(|s| s.trim()).filter(|s| !s.is_empty()).map(str::to_string);
                let upstream = parts.next().map(|s| s.trim()).filter(|s| !s.is_empty()).map(str::to_string);
                Some(BranchEntry { name, current: head.trim() == "*", short_sha, upstream })
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// Returns the list of commits that are ahead (local-only) and behind (upstream-only)
/// the tracking branch. Used for the VSCode-style sync popover on the commits chip.
#[tauri::command]
pub async fn get_commit_sync(cwd: String) -> CommitSync {
    let empty = CommitSync { ahead: vec![], behind: vec![], has_upstream: false };
    tauri::async_runtime::spawn_blocking(move || {
        fn run(cwd: &str, args: &[&str]) -> Option<String> {
            let mut cmd = std::process::Command::new("git");
            cmd.arg("-C").arg(cwd).args(args);
            crate::util::process::hide_console(&mut cmd);
            cmd.output()
                .ok()
                .filter(|o| o.status.success())
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        }
        fn parse_log(raw: Option<String>) -> Vec<CommitEntry> {
            raw.unwrap_or_default()
                .lines()
                .take(50)
                .filter_map(|l| {
                    let (sha, msg) = l.split_once('|')?;
                    Some(CommitEntry { short_sha: sha.trim().to_string(), message: msg.to_string() })
                })
                .collect()
        }
        if run(&cwd, &["rev-parse", "@{u}"]).is_none() {
            return CommitSync { ahead: vec![], behind: vec![], has_upstream: false };
        }
        CommitSync {
            ahead: parse_log(run(&cwd, &["log", "--pretty=format:%h|%s", "@{u}..HEAD"])),
            behind: parse_log(run(&cwd, &["log", "--pretty=format:%h|%s", "HEAD..@{u}"])),
            has_upstream: true,
        }
    })
    .await
    .unwrap_or(empty)
}

/// Git empty-tree hash, used as the lower bound when the requested commit
/// has no parent (root commit).
const EMPTY_TREE_SHA: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct PrFileChange {
    pub path: String,
    pub status: String,
    pub added: u32,
    pub removed: u32,
    pub old_path: Option<String>,
}

/// Resolves the lower bound of a `(lower, to]` range: the parent of `from` if
/// given, else the parent of `to`. Falls back to the git empty-tree hash when
/// the target commit has no parent (root commit).
fn resolve_lower_bound(cwd: &str, from: &Option<String>, to: &str) -> String {
    let target = from.as_deref().unwrap_or(to);
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(cwd).args(["rev-parse", &format!("{target}^")]);
    crate::util::process::hide_console(&mut cmd);
    cmd.output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| EMPTY_TREE_SHA.to_string())
}

/// Expands a rename path as it appears in `--numstat` output, which can be
/// either the plain arrow form (`old => new`) or the brace-shortened form
/// (`prefix{old => new}suffix`). Returns the resolved new path.
fn resolve_numstat_new_path(raw: &str) -> String {
    if let Some(brace_start) = raw.find('{') {
        if let Some(brace_end) = raw[brace_start..].find('}') {
            let brace_end = brace_start + brace_end;
            let prefix = &raw[..brace_start];
            let suffix = &raw[brace_end + 1..];
            let inner = &raw[brace_start + 1..brace_end];
            if let Some((_old, new)) = inner.split_once(" => ") {
                return format!("{prefix}{new}{suffix}");
            }
            return raw.to_string();
        }
    }
    if let Some((_old, new)) = raw.split_once(" => ") {
        return new.to_string();
    }
    raw.to_string()
}

/// Merges `git diff --name-status -M` and `git diff --numstat -M` output for
/// the same range into a single list of file changes. name-status supplies
/// status + rename old/new paths; numstat supplies added/removed counts
/// (`-`/`-` for binary files, treated as 0/0). Joined by the new path; if a
/// numstat line can't be resolved to a known path, the file is kept with
/// zeroed counts rather than dropped.
fn parse_range_files(name_status: &str, numstat: &str) -> Vec<PrFileChange> {
    let mut entries: Vec<PrFileChange> = Vec::new();

    for line in name_status.lines() {
        let mut parts = line.splitn(2, '\t');
        let raw_status = match parts.next() {
            Some(s) if !s.is_empty() => s,
            _ => continue,
        };
        let rest = match parts.next() {
            Some(r) => r,
            None => continue,
        };
        let status = raw_status.chars().next().unwrap_or('M').to_string();

        if raw_status.starts_with('R') {
            let mut fields = rest.splitn(2, '\t');
            let old_path = fields.next().unwrap_or_default().to_string();
            let path = fields.next().unwrap_or_default().to_string();
            if path.is_empty() {
                continue;
            }
            entries.push(PrFileChange { path, status, added: 0, removed: 0, old_path: Some(old_path) });
        } else {
            if rest.is_empty() {
                continue;
            }
            entries.push(PrFileChange { path: rest.to_string(), status, added: 0, removed: 0, old_path: None });
        }
    }

    for line in numstat.lines() {
        let mut parts = line.splitn(3, '\t');
        let added = match parts.next() {
            Some(s) => s,
            None => continue,
        };
        let removed = match parts.next() {
            Some(s) => s,
            None => continue,
        };
        let name_field = match parts.next() {
            Some(s) => s,
            None => continue,
        };

        let added: u32 = added.parse().unwrap_or(0);
        let removed: u32 = removed.parse().unwrap_or(0);
        let new_path = resolve_numstat_new_path(name_field);

        if let Some(entry) = entries.iter_mut().find(|e| e.path == new_path) {
            entry.added = added;
            entry.removed = removed;
        } else if !new_path.is_empty() {
            // No matching name-status line (shouldn't normally happen since both
            // commands cover the same range) - keep the file rather than drop it.
            entries.push(PrFileChange {
                path: new_path,
                status: "M".to_string(),
                added,
                removed,
                old_path: None,
            });
        }
    }

    entries
}

/// Returns the files changed in the range `(lower, to]`, where `lower` is the
/// parent of `from` if given, else the parent of `to`. Passing `from: None`
/// yields the files touched by the single commit `to`; passing `from: Some(oldest)`
/// yields the cumulative files touched across the whole range up to `to`.
#[tauri::command]
pub async fn get_range_files(cwd: String, from: Option<String>, to: String) -> Result<Vec<PrFileChange>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let lower = resolve_lower_bound(&cwd, &from, &to);

        fn run(cwd: &str, args: &[&str]) -> Result<String, String> {
            let mut cmd = std::process::Command::new("git");
            cmd.arg("-C").arg(cwd).args(args);
            crate::util::process::hide_console(&mut cmd);
            let output = cmd.output().map_err(|e| format!("failed to run git: {e}"))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                return Err(if stderr.is_empty() { "git command failed".to_string() } else { stderr });
            }
            String::from_utf8(output.stdout).map_err(|e| format!("git output was not utf-8: {e}"))
        }

        let name_status = run(&cwd, &["diff", "--name-status", "-M", &lower, &to])?;
        let numstat = run(&cwd, &["diff", "--numstat", "-M", &lower, &to])?;

        Ok(parse_range_files(&name_status, &numstat))
    })
    .await
    .map_err(|e| format!("get_range_files join error: {e}"))?
}

/// Returns the raw unified diff for a single file in the range `(lower, to]`,
/// with the same lower-bound resolution as `get_range_files`. Truncates at a
/// line boundary before 1MB with a trailing marker.
#[tauri::command]
pub async fn get_file_diff(cwd: String, from: Option<String>, to: String, path: String) -> Result<String, String> {
    const MAX_BYTES: usize = 1_000_000;

    tauri::async_runtime::spawn_blocking(move || {
        let lower = resolve_lower_bound(&cwd, &from, &to);

        let mut cmd = std::process::Command::new("git");
        cmd.arg("-C").arg(&cwd).args(["diff", &lower, &to, "--", &path]);
        crate::util::process::hide_console(&mut cmd);
        let output = cmd.output().map_err(|e| format!("failed to run git: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if stderr.is_empty() { "git command failed".to_string() } else { stderr });
        }
        let text = String::from_utf8_lossy(&output.stdout).to_string();

        if text.len() <= MAX_BYTES {
            return Ok(text);
        }
        let mut cut = MAX_BYTES;
        while cut > 0 && !text.is_char_boundary(cut) {
            cut -= 1;
        }
        let truncated = match text[..cut].rfind('\n') {
            Some(idx) => &text[..idx],
            None => &text[..cut],
        };
        Ok(format!("{truncated}\n... (diff truncated)"))
    })
    .await
    .map_err(|e| format!("get_file_diff join error: {e}"))?
}

#[cfg(test)]
mod git_info_tests {
    use super::parse_shortstat;

    #[test]
    fn parses_insertions_and_deletions() {
        assert_eq!(parse_shortstat(" 3 files changed, 42 insertions(+), 7 deletions(-)"), (Some(42), Some(7)));
    }
    #[test]
    fn parses_insertions_only() {
        assert_eq!(parse_shortstat(" 1 file changed, 5 insertions(+)"), (Some(5), Some(0)));
    }
    #[test]
    fn parses_deletions_only() {
        assert_eq!(parse_shortstat(" 1 file changed, 9 deletions(-)"), (Some(0), Some(9)));
    }
    #[test]
    fn empty_is_none() {
        assert_eq!(parse_shortstat(""), (None, None));
    }
}

#[cfg(test)]
mod range_files_tests {
    use super::parse_range_files;

    #[test]
    fn normal_modify_add_delete() {
        let name_status = "M\tsrc/a.rs\nA\tsrc/b.rs\nD\tsrc/c.rs";
        let numstat = "3\t1\tsrc/a.rs\n10\t0\tsrc/b.rs\n0\t5\tsrc/c.rs";
        let files = parse_range_files(name_status, numstat);
        assert_eq!(files.len(), 3);

        let a = files.iter().find(|f| f.path == "src/a.rs").unwrap();
        assert_eq!(a.status, "M");
        assert_eq!(a.added, 3);
        assert_eq!(a.removed, 1);
        assert_eq!(a.old_path, None);

        let b = files.iter().find(|f| f.path == "src/b.rs").unwrap();
        assert_eq!(b.status, "A");
        assert_eq!(b.added, 10);
        assert_eq!(b.removed, 0);

        let c = files.iter().find(|f| f.path == "src/c.rs").unwrap();
        assert_eq!(c.status, "D");
        assert_eq!(c.added, 0);
        assert_eq!(c.removed, 5);
    }

    #[test]
    fn rename_with_counts_plain_arrow() {
        let name_status = "R100\told/name.rs\tnew/name.rs";
        let numstat = "2\t2\told/name.rs => new/name.rs";
        let files = parse_range_files(name_status, numstat);
        assert_eq!(files.len(), 1);
        let f = &files[0];
        assert_eq!(f.path, "new/name.rs");
        assert_eq!(f.status, "R");
        assert_eq!(f.old_path.as_deref(), Some("old/name.rs"));
        assert_eq!(f.added, 2);
        assert_eq!(f.removed, 2);
    }

    #[test]
    fn binary_file_counts_are_zero() {
        let name_status = "M\tassets/logo.png";
        let numstat = "-\t-\tassets/logo.png";
        let files = parse_range_files(name_status, numstat);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].added, 0);
        assert_eq!(files[0].removed, 0);
    }

    #[test]
    fn rename_with_brace_form_path() {
        let name_status = "R095\tsrc/old_dir/file.rs\tsrc/new_dir/file.rs";
        let numstat = "4\t1\tsrc/{old_dir => new_dir}/file.rs";
        let files = parse_range_files(name_status, numstat);
        assert_eq!(files.len(), 1);
        let f = &files[0];
        assert_eq!(f.path, "src/new_dir/file.rs");
        assert_eq!(f.status, "R");
        assert_eq!(f.old_path.as_deref(), Some("src/old_dir/file.rs"));
        assert_eq!(f.added, 4);
        assert_eq!(f.removed, 1);
    }
}
