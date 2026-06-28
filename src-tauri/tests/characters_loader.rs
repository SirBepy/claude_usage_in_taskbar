//! Integration test for character loader against a real temp dir layout.

use claude_conductor_lib::characters::loader;
use std::fs;
use tempfile::TempDir;

fn write_char(root: &std::path::Path, id: &str, slot_files: &[(&str, &[&str])]) {
    let dir = root.join(id);
    fs::create_dir_all(dir.join("sounds")).unwrap();
    let slots_json: String = slot_files.iter().map(|(slot, files)| {
        let arr = files.iter().map(|f| format!("\"sounds/{f}\"")).collect::<Vec<_>>().join(",");
        format!("\"{slot}\": [{arr}]")
    }).collect::<Vec<_>>().join(",");
    let json = format!(r#"{{
        "id": "{id}", "label": "Test {id}", "icon": "icon.png",
        "slots": {{ {slots_json} }}
    }}"#);
    fs::write(dir.join("character.json"), json).unwrap();
    fs::write(dir.join("icon.png"), b"x").unwrap();
    for (_, files) in slot_files {
        for f in *files {
            fs::write(dir.join("sounds").join(f), b"x").unwrap();
        }
    }
}

#[test]
fn loads_three_characters_in_id_order() {
    let tmp = TempDir::new().unwrap();
    write_char(tmp.path(), "peon", &[("work_finished", &["done.wav"])]);
    write_char(tmp.path(), "acolyte", &[("work_finished", &["serve.wav"])]);
    write_char(tmp.path(), "peasant", &[("work_finished", &["ready.wav"])]);
    let chars = loader::load_all(tmp.path());
    let ids: Vec<_> = chars.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, vec!["acolyte", "peasant", "peon"]);
}
