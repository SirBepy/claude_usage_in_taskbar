//! Idempotency of install() using a pre-populated sound-packs dir.
//! We don't hit the network; we simulate "already installed" by creating
//! the expected dir+file and confirm install() is a no-op.

use claude_usage_tauri_lib::settings::paths;
use claude_usage_tauri_lib::notifications::soundpacks;
use std::fs;

#[test]
fn install_skips_when_already_installed() {
    let dir = paths::sound_packs_dir().expect("sound packs dir");
    let pack_dir = dir.join("peon");
    fs::create_dir_all(&pack_dir).unwrap();
    fs::write(pack_dir.join("work-work.wav"), b"fake").unwrap();
    assert!(soundpacks::is_installed("peon"));

    let before = fs::metadata(&pack_dir).unwrap().modified().ok();
    tauri::async_runtime::block_on(soundpacks::install("peon")).unwrap();
    let after = fs::metadata(&pack_dir).unwrap().modified().ok();
    assert_eq!(before, after);

    fs::remove_dir_all(&pack_dir).ok();
}
