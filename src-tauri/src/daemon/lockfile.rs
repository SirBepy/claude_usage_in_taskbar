use std::path::PathBuf;
use std::fs;
use std::io::Write;

#[derive(Debug, thiserror::Error)]
pub enum LockError {
    #[error("daemon already running (pid {0})")]
    AlreadyHeld(u32),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug)]
pub struct LockGuard {
    path: PathBuf,
}

impl LockGuard {
    pub fn acquire(path: PathBuf) -> Result<Self, LockError> {
        // Existing lockfile: live PID blocks; dead PID or malformed contents
        // (partial write from a crash, garbage) is treated as stale and
        // reclaimed. Single-instance daemon = no concurrent acquires expected,
        // so the TOCTOU window between this check and the create below is OK.
        if let Ok(contents) = fs::read_to_string(&path) {
            if let Ok(existing_pid) = contents.trim().parse::<u32>() {
                if pid_is_live(existing_pid) {
                    return Err(LockError::AlreadyHeld(existing_pid));
                }
            }
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut f = fs::File::create(&path)?;
        writeln!(f, "{}", std::process::id())?;
        Ok(LockGuard { path })
    }
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

use crate::util::process::pid_is_live;

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn tmpfile(name: &str) -> PathBuf {
        let mut p = env::temp_dir();
        p.push(format!("cc-conductor-daemon-test-{}-{}.lock", name, std::process::id()));
        let _ = fs::remove_file(&p);
        p
    }

    #[test]
    fn acquire_creates_lockfile_with_current_pid() {
        let p = tmpfile("acquire");
        let _g = LockGuard::acquire(p.clone()).expect("acquire");
        let contents = fs::read_to_string(&p).expect("read");
        let pid: u32 = contents.trim().parse().expect("pid");
        assert_eq!(pid, std::process::id());
    }

    #[test]
    fn drop_removes_lockfile() {
        let p = tmpfile("drop");
        {
            let _g = LockGuard::acquire(p.clone()).expect("acquire");
            assert!(p.exists());
        }
        assert!(!p.exists());
    }

    #[test]
    fn stale_pid_is_reclaimed() {
        let p = tmpfile("stale");
        // Write a definitely-dead PID (max u32 - unlikely to ever be a real PID).
        let mut f = fs::File::create(&p).expect("create");
        writeln!(f, "{}", u32::MAX).expect("write");
        drop(f);
        let _g = LockGuard::acquire(p.clone()).expect("reclaim stale");
        let contents = fs::read_to_string(&p).expect("read");
        assert_eq!(contents.trim().parse::<u32>().unwrap(), std::process::id());
    }

    #[test]
    fn live_pid_blocks_acquire() {
        let p = tmpfile("live");
        // Use our own PID (definitely alive).
        let mut f = fs::File::create(&p).expect("create");
        writeln!(f, "{}", std::process::id()).expect("write");
        drop(f);
        match LockGuard::acquire(p.clone()) {
            Err(LockError::AlreadyHeld(pid)) => assert_eq!(pid, std::process::id()),
            other => panic!("expected AlreadyHeld, got {other:?}"),
        }
        // Cleanup
        let _ = fs::remove_file(&p);
    }
}
