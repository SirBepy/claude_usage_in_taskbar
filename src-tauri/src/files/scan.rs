use std::path::Path;
use std::process::Command;

pub fn scan(project_dir: &Path) -> Result<Vec<String>, String> {
    if !project_dir.is_dir() {
        return Ok(vec![]);
    }
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(project_dir)
        .args(["ls-files", "-co", "--exclude-standard"]);
    no_window(&mut cmd);
    let out = match cmd.output() {
        Ok(o) => o,
        Err(e) => {
            log::warn!("[files] git spawn failed: {e}");
            return Ok(vec![]);
        }
    };
    if !out.status.success() {
        return Ok(vec![]);
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut paths: Vec<String> = stdout
        .lines()
        .filter(|s| !s.is_empty())
        .map(|s| s.replace('\\', "/"))
        .collect();
    paths.sort();
    paths.truncate(5000);
    Ok(paths)
}

#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn no_window(_cmd: &mut Command) {}
