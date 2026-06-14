# 99 - Project tech-icon detection for project face

## Context
The per-session characters refactor (2026-06-14) decoupled characters from projects. Projects no longer have a character face; they currently fall back to a placeholder (`Avatar::None`). The intended real project face is the project's own icon, or a detected fallback icon based on the project's technology/stack.

## Task
Detect a project's icon / tech-stack and render it as the project face (projects list + project-detail header), replacing the placeholder.

server_supervisor already has a way to detect project icons/tech - copy that approach (dispatch a read-only subagent to server_supervisor's repo to extract the detection logic + icon asset set, then adapt).

## Notes
- Project face render sites: `ipc/project_groups.rs` (builds `ProjectGroup.avatar`), frontend sidebar/project-detail avatar rendering (`shared/projects.ts renderAvatar`).
- Keep custom `Emoji`/`Image` avatars the user set; only the placeholder/auto path uses tech detection.
