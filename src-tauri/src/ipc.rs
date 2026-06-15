pub mod usage;
pub mod settings;
pub mod projects;
pub mod project_groups;
pub mod project_icons;
pub mod channels;
pub mod chat;
pub mod tokens;
pub mod auth;
pub mod misc;
pub mod models;
pub mod window;
pub mod update;
pub mod characters;
pub mod audio;
pub mod news;
pub mod slash;
pub mod files;
pub mod skill_usage;

pub use usage::*;
pub use settings::*;
pub use projects::*;
pub use project_groups::*;
pub use project_icons::*;
pub use channels::*;
pub use chat::*;
pub use tokens::*;
pub use auth::*;
pub use misc::*;
pub use models::*;
pub use window::*;
pub use update::*;
pub use characters::*;
pub use audio::*;
pub use news::*;
pub use slash::*;
pub use files::*;
pub use skill_usage::*;

// Re-export test helper submodules so integration tests can reach them via
// `claude_usage_tauri_lib::ipc::projects_test_helpers` and
// `claude_usage_tauri_lib::ipc::legacy_import_test_helpers`.
pub use projects::projects_test_helpers;
pub use projects::legacy_import_test_helpers;
