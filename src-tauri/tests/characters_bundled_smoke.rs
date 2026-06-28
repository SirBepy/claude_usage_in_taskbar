use claude_conductor_lib::characters::loader;
use std::path::PathBuf;

fn bundled_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets").join("characters")
}

#[test]
fn peon_bundled_character_loads() {
    let chars = loader::load_all(&bundled_dir());
    assert!(chars.iter().any(|c| c.id == "peon"), "peon must load: {chars:?}");
}

#[test]
fn peasant_bundled_character_loads() {
    let chars = loader::load_all(&bundled_dir());
    assert!(chars.iter().any(|c| c.id == "peasant"));
}

#[test]
fn acolyte_bundled_character_loads() {
    let chars = loader::load_all(&bundled_dir());
    assert!(chars.iter().any(|c| c.id == "acolyte"));
}
