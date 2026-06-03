pub mod process;

/// Write `json` to `path` atomically via a `.json.tmp` sibling and rename.
/// Creates the parent directory if absent (non-fatal). Returns an error if
/// the write or rename fails.
pub(crate) fn write_json_atomic(path: &std::path::Path, json: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)
}
