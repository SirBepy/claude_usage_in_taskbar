use std::collections::HashMap;
use std::sync::Mutex;
use crate::types::ChannelStatus;

// -------- Manager --------

pub struct ChannelSnapshot {
    pub project_id: String,
    pub pid: Option<u32>,
    pub status: ChannelStatus,
    pub hwnd: Option<isize>,
}

/// Single source of truth for `ChannelSnapshot` -> JSON shape consumed by
/// the frontend (both via `list_channels` IPC and `channels-changed` event).
/// Exposes `has_hwnd: bool` rather than the raw HWND because no frontend
/// consumer reads the raw value today.
pub(crate) fn channel_snapshot_to_json(s: &ChannelSnapshot) -> serde_json::Value {
    serde_json::json!({
        "project_id": s.project_id,
        "pid": s.pid,
        "status": match s.status {
            ChannelStatus::Starting => "starting",
            ChannelStatus::Running  => "running",
            ChannelStatus::Stopped  => "stopped",
            ChannelStatus::Crashed  => "crashed",
        },
        "has_hwnd": s.hwnd.is_some(),
    })
}

pub struct Manager {
    channels: Mutex<HashMap<String, ChannelSnapshot>>,
}

impl Manager {
    pub fn new() -> Self {
        Self {
            channels: Mutex::new(HashMap::new()),
        }
    }

    pub fn snapshot(&self, project_id: &str) -> Option<ChannelSnapshot> {
        self.channels.lock().unwrap().get(project_id).map(|s| ChannelSnapshot {
            project_id: s.project_id.clone(),
            pid: s.pid,
            status: s.status,
            hwnd: s.hwnd,
        })
    }

    pub fn list(&self) -> Vec<ChannelSnapshot> {
        self.channels
            .lock()
            .unwrap()
            .values()
            .map(|s| ChannelSnapshot {
                project_id: s.project_id.clone(),
                pid: s.pid,
                status: s.status,
                hwnd: s.hwnd,
            })
            .collect()
    }

    pub(crate) fn put(&self, snap: ChannelSnapshot) {
        let mut g = self.channels.lock().unwrap();
        g.insert(snap.project_id.clone(), snap);
    }

    #[allow(dead_code)]
    pub(crate) fn remove(&self, project_id: &str) {
        self.channels.lock().unwrap().remove(project_id);
    }

    pub(crate) fn patch<F: FnOnce(&mut ChannelSnapshot)>(&self, project_id: &str, f: F) {
        if let Some(s) = self.channels.lock().unwrap().get_mut(project_id) {
            f(s);
        }
    }
}
