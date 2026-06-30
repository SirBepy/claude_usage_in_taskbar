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
