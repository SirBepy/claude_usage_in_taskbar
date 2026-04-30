# AI todos

- [ ] Split `src-tauri/src/ipc/projects.rs` (675 lines) - extract `groups_test_helpers`, `build_groups_tests`, and the `list_project_groups` command into `src-tauri/src/ipc/project_groups.rs`. Reason: file crossed the 400-line threshold during the project-grouping work, has a clean seam.
- [ ] Split `src-tauri/src/settings/store.rs` (521 lines) - extract identity helpers (`find_repo_root`, `normalize_path`, `project_key`, `normalize_cwd_key`, `dedupe_projects_by_path_key`) into `src-tauri/src/settings/identity.rs`. Reason: file crossed 400 lines, the load/save concern and the identity concern can decouple cleanly.
