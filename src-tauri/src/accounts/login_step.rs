//! Interactive `/login` step. There is no headless login (locked decision,
//! 00-overview.md): the wizard spawns a VISIBLE terminal with
//! `CLAUDE_CONFIG_DIR` set to the profile dir, the user runs `/login` and
//! picks the right account by hand, and the wizard polls `.claude.json` for
//! `oauthAccount` to appear/refresh. `claude setup-token` is never used here.

use super::identity::{self, OauthAccountInfo};
use std::path::Path;

/// Result of comparing the profile dir's current identity against the
/// baseline captured when the wizard step started.
#[derive(Debug, Clone, PartialEq)]
pub enum LoginPollResult {
    /// No identity yet, or the identity present is the same one that was
    /// already there before this login attempt started (login hasn't
    /// completed).
    Pending,
    /// A fresh (or newly-appeared) identity was observed.
    Ready(OauthAccountInfo),
}

/// Polls `<config_dir>/.claude.json` and compares against `baseline_fetched_at`
/// (the `profileFetchedAt` captured before the login terminal was spawned, or
/// `None` for a brand-new dir that never had an identity). A login is
/// considered complete once `profileFetchedAt` is present and strictly newer
/// than the baseline (RFC3339 timestamps sort lexicographically, so a plain
/// string compare is enough - same convention `ProjectConfig.last_active_at`
/// comparisons use elsewhere in this codebase).
pub fn poll_login(config_dir: &Path, baseline_fetched_at: Option<&str>) -> LoginPollResult {
    let Some(identity) = identity::read_oauth_account(config_dir) else {
        return LoginPollResult::Pending;
    };
    let is_fresh = match (baseline_fetched_at, identity.profile_fetched_at.as_deref()) {
        (None, _) => true,
        (Some(_), None) => false,
        (Some(base), Some(now)) => now > base,
    };
    if is_fresh {
        LoginPollResult::Ready(identity)
    } else {
        LoginPollResult::Pending
    }
}

/// Spawns a visible terminal running `claude` with `CLAUDE_CONFIG_DIR` set to
/// `config_dir`, so the user can run `/login` inside that isolated profile.
/// The env var is baked into the shell command string (not set via
/// `Command::env`) because several of these terminal launchers (Windows
/// Terminal, gnome-terminal) hand the command off to an already-running
/// server process rather than inheriting our env directly.
pub fn spawn_login_terminal(config_dir: &Path) -> std::io::Result<()> {
    imp::spawn(config_dir)
}

#[cfg(target_os = "windows")]
mod imp {
    use std::path::Path;
    use std::process::Command;

    pub fn spawn(config_dir: &Path) -> std::io::Result<()> {
        let dir_str = config_dir.to_string_lossy().to_string();
        let inner = format!("set CLAUDE_CONFIG_DIR={dir_str}&&claude");
        // Prefer Windows Terminal.
        let mut wt = Command::new("wt.exe");
        wt.args(["-d", &dir_str, "cmd.exe", "/K", &inner]);
        if wt.spawn().is_ok() {
            return Ok(());
        }
        // Fall back to a bare cmd.exe console window.
        let mut fallback = Command::new("cmd.exe");
        fallback.arg("/C").arg("start").arg("").arg("cmd.exe").arg("/K").arg(&inner);
        fallback.current_dir(config_dir);
        fallback.spawn()?;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::path::Path;
    use std::process::Command;

    pub fn spawn(config_dir: &Path) -> std::io::Result<()> {
        let dir_esc = config_dir.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!(
            "tell application \"Terminal\" to do script \"cd \\\"{dir_esc}\\\" && export CLAUDE_CONFIG_DIR=\\\"{dir_esc}\\\" && claude\""
        );
        Command::new("osascript").arg("-e").arg(&script).spawn()?;
        let _ = Command::new("osascript")
            .arg("-e")
            .arg("tell application \"Terminal\" to activate")
            .spawn();
        Ok(())
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use std::path::Path;
    use std::process::Command;

    pub fn spawn(config_dir: &Path) -> std::io::Result<()> {
        let dir_str = config_dir.to_string_lossy().to_string();
        let run = format!("export CLAUDE_CONFIG_DIR=\"{dir_str}\"; claude; exec bash");
        let candidates = ["gnome-terminal", "konsole", "xfce4-terminal", "xterm"];
        for bin in candidates {
            let mut cmd = Command::new(bin);
            match bin {
                "gnome-terminal" => {
                    cmd.arg(format!("--working-directory={dir_str}"));
                    cmd.arg("--").arg("bash").arg("-c").arg(&run);
                }
                "konsole" => {
                    cmd.arg("--workdir").arg(&dir_str);
                    cmd.arg("-e").arg("bash").arg("-c").arg(&run);
                }
                "xfce4-terminal" => {
                    cmd.arg(format!("--working-directory={dir_str}"));
                    cmd.arg("-e").arg(format!("bash -c '{run}'"));
                }
                _ => {
                    cmd.current_dir(config_dir);
                    cmd.arg("-e").arg("bash").arg("-c").arg(&run);
                }
            }
            if cmd.spawn().is_ok() {
                return Ok(());
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no supported terminal emulator found (tried gnome-terminal, konsole, xfce4-terminal, xterm)",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_identity(dir: &Path, fetched_at: &str) {
        let raw = format!(
            r#"{{"oauthAccount": {{"emailAddress": "a@x.com", "organizationUuid": "org-1", "profileFetchedAt": "{fetched_at}"}}}}"#
        );
        std::fs::write(dir.join(".claude.json"), raw).unwrap();
    }

    #[test]
    fn poll_pending_when_no_identity_file_yet() {
        let dir = tempdir().unwrap();
        assert_eq!(poll_login(dir.path(), None), LoginPollResult::Pending);
    }

    #[test]
    fn poll_ready_on_first_identity_with_no_baseline() {
        let dir = tempdir().unwrap();
        write_identity(dir.path(), "2026-07-07T10:00:00Z");
        match poll_login(dir.path(), None) {
            LoginPollResult::Ready(identity) => assert_eq!(identity.email_address, "a@x.com"),
            other => panic!("expected Ready, got {other:?}"),
        }
    }

    #[test]
    fn poll_pending_when_identity_unchanged_since_baseline() {
        let dir = tempdir().unwrap();
        write_identity(dir.path(), "2026-07-07T10:00:00Z");
        assert_eq!(
            poll_login(dir.path(), Some("2026-07-07T10:00:00Z")),
            LoginPollResult::Pending
        );
    }

    #[test]
    fn poll_ready_when_identity_refreshed_after_baseline() {
        let dir = tempdir().unwrap();
        write_identity(dir.path(), "2026-07-07T11:00:00Z");
        match poll_login(dir.path(), Some("2026-07-07T10:00:00Z")) {
            LoginPollResult::Ready(_) => {}
            other => panic!("expected Ready, got {other:?}"),
        }
    }

    #[test]
    fn poll_pending_when_baseline_present_but_new_identity_has_no_timestamp() {
        let dir = tempdir().unwrap();
        std::fs::write(
            dir.path().join(".claude.json"),
            r#"{"oauthAccount": {"emailAddress": "a@x.com", "organizationUuid": "org-1"}}"#,
        )
        .unwrap();
        assert_eq!(
            poll_login(dir.path(), Some("2026-07-07T10:00:00Z")),
            LoginPollResult::Pending
        );
    }
}
