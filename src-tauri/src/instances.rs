//! In-memory instance registry.
//!
//! Keyed by `session_id`. The canonical source for "what Claude Code
//! processes are currently alive across the machine". Populated by
//! `hook_server.rs` (SessionStart hook), `detector.rs` (ps reconcile),
//! and `channels.rs` (future, Plan C). Any mutation emits an
//! `instances-changed` Tauri event so the webview refreshes.

use crate::settings;
use crate::types::{EndReason, Instance, InstanceKind, Settings};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Clone, Debug)]
pub struct RegisterInput {
    pub session_id: String,
    pub cwd: PathBuf,
    pub pid: u32,
    pub kind: InstanceKind,
    pub is_remote: bool,
    pub transcript_path: Option<PathBuf>,
    pub started_at: String,
}

pub struct Registry {
    inner: Mutex<HashMap<String, Instance>>,
}

impl Registry {
    pub fn new() -> Self { Self { inner: Mutex::new(HashMap::new()) } }

    /// Inserts or updates an instance. Returns `(project_id, created_new)`.
    /// `project_id` is resolved via `settings::upsert_project_for_cwd`.
    /// If the session is already registered, the existing project id is
    /// kept and `created_new` is `false`.
    pub fn register(
        &self,
        input: RegisterInput,
        settings: &Mutex<Settings>,
        now: &str,
    ) -> (String, bool) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(existing) = guard.get(&input.session_id) {
            return (existing.project_id.clone(), false);
        }
        let (project_id, _) = {
            let mut s = settings.lock().unwrap();
            settings::upsert_project_for_cwd(&mut s, &input.cwd, now)
        };
        let instance = Instance {
            session_id: input.session_id.clone(),
            pid: input.pid,
            cwd: input.cwd,
            project_id: project_id.clone(),
            kind: input.kind,
            is_remote: input.is_remote,
            started_at: input.started_at,
            transcript_path: input.transcript_path,
            bridge_session_id: None,
            ended_at: None,
            end_reason: None,
        };
        guard.insert(input.session_id, instance);
        (project_id, true)
    }

    /// Marks an instance as ended. Idempotent: returns `true` only the
    /// first time (when `end_reason` flips from None to Some).
    pub fn mark_ended(&self, session_id: &str, reason: EndReason, when: &str) -> bool {
        let mut guard = self.inner.lock().unwrap();
        let Some(inst) = guard.get_mut(session_id) else { return false };
        if inst.end_reason.is_some() { return false; }
        inst.end_reason = Some(reason);
        inst.ended_at = Some(when.to_string());
        true
    }

    pub fn set_bridge_session_id(&self, session_id: &str, bridge_id: String) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(i) = guard.get_mut(session_id) {
            i.bridge_session_id = Some(bridge_id);
        }
    }

    /// Remove ended instances whose `ended_at` is strictly before `cutoff`.
    /// Cutoff is an RFC3339 string; lexicographic comparison works on
    /// `Z`-suffix timestamps.
    pub fn prune_ended_before(&self, cutoff: &str) {
        let mut guard = self.inner.lock().unwrap();
        guard.retain(|_, i| match i.ended_at.as_deref() {
            None => true,
            Some(t) => t >= cutoff,
        });
    }

    pub fn list(&self) -> Vec<Instance> {
        self.inner.lock().unwrap().values().cloned().collect()
    }

    pub fn by_cwd(&self, cwd: &std::path::Path) -> Vec<Instance> {
        self.inner
            .lock()
            .unwrap()
            .values()
            .filter(|i| i.cwd == cwd)
            .cloned()
            .collect()
    }

    pub fn by_project(&self, project_id: &str) -> Vec<Instance> {
        self.inner
            .lock()
            .unwrap()
            .values()
            .filter(|i| i.project_id == project_id)
            .cloned()
            .collect()
    }

    pub fn get(&self, session_id: &str) -> Option<Instance> {
        self.inner.lock().unwrap().get(session_id).cloned()
    }

    pub fn known_session_ids(&self) -> Vec<String> {
        self.inner.lock().unwrap().keys().cloned().collect()
    }
}
