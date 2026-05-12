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
    crate::util::process::hide_console(&mut cmd);
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
