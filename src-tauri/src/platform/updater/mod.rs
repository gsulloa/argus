pub mod commands;

use std::sync::atomic::AtomicBool;

use tauri_plugin_updater::Update;
use tokio::sync::Mutex;

pub struct PendingUpdate {
    pub update: Update,
    pub bytes: Vec<u8>,
}

pub struct UpdaterState {
    pub pending: Mutex<Option<PendingUpdate>>,
    pub installing: AtomicBool,
    pub relaunching: AtomicBool,
}

impl Default for UpdaterState {
    fn default() -> Self {
        Self {
            pending: Mutex::new(None),
            installing: AtomicBool::new(false),
            relaunching: AtomicBool::new(false),
        }
    }
}
