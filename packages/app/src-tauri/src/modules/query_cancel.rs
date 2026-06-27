use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use uuid::Uuid;

/// A best-effort async action that aborts the in-flight query server-side.
pub type CancelAction = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

struct Entry {
    action: Option<CancelAction>, // None == tombstone (cancel arrived before register)
    flag: Arc<AtomicBool>,        // shared with the run path's CancelGuard
}

#[derive(Default)]
pub struct RunningQueryRegistry {
    map: Arc<Mutex<HashMap<Uuid, Entry>>>,
}

/// Removes the registry entry on drop; exposes the shared cancel flag.
pub struct CancelGuard {
    map: Arc<Mutex<HashMap<Uuid, Entry>>>,
    token: Uuid,
    flag: Arc<AtomicBool>,
}

impl CancelGuard {
    /// True once a cancel has been requested for this run.
    pub fn cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        self.map.lock().unwrap().remove(&self.token);
    }
}

impl RunningQueryRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register an in-flight run. If a cancel tombstone already exists for the
    /// token, the returned guard's flag is already set and `action` is fired
    /// immediately (awaited). Returns a guard that must be held for the run.
    pub async fn register(&self, token: Uuid, action: CancelAction) -> CancelGuard {
        let (flag, fire_now) = {
            let mut map = self.map.lock().unwrap();
            match map.remove(&token) {
                Some(prev) => {
                    // tombstone: cancel already requested
                    let flag = prev.flag;
                    flag.store(true, Ordering::SeqCst);
                    map.insert(
                        token,
                        Entry {
                            action: Some(action.clone()),
                            flag: flag.clone(),
                        },
                    );
                    (flag, true)
                }
                None => {
                    let flag = Arc::new(AtomicBool::new(false));
                    map.insert(
                        token,
                        Entry {
                            action: Some(action),
                            flag: flag.clone(),
                        },
                    );
                    (flag, false)
                }
            }
        };
        if fire_now {
            let action = self
                .map
                .lock()
                .unwrap()
                .get(&token)
                .and_then(|e| e.action.clone());
            if let Some(a) = action {
                a().await;
            }
        }
        CancelGuard {
            map: self.map.clone(),
            token,
            flag,
        }
    }

    /// Request cancellation: set the flag and fire the action best-effort.
    /// Idempotent; a no-op (creating a tombstone) when the token is unknown.
    pub async fn request_cancel(&self, token: Uuid) {
        let action = {
            let mut map = self.map.lock().unwrap();
            match map.get_mut(&token) {
                Some(entry) => {
                    entry.flag.store(true, Ordering::SeqCst);
                    entry.action.clone()
                }
                None => {
                    // tombstone for a cancel that raced ahead of register()
                    map.insert(
                        token,
                        Entry {
                            action: None,
                            flag: Arc::new(AtomicBool::new(true)),
                        },
                    );
                    None
                }
            }
        };
        if let Some(a) = action {
            a().await;
        }
    }
}

#[tauri::command]
pub async fn cancel_running_query(
    registry: tauri::State<'_, RunningQueryRegistry>,
    run_token: String,
) -> crate::error::AppResult<()> {
    if let Ok(token) = Uuid::parse_str(&run_token) {
        registry.request_cancel(token).await;
    }
    Ok(()) // unknown / malformed / finished token → no-op, never errors
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    fn noop_action() -> CancelAction {
        Arc::new(|| Box::pin(async {}))
    }

    fn flag_action(flag: Arc<AtomicBool>) -> CancelAction {
        Arc::new(move || {
            let flag = flag.clone();
            Box::pin(async move {
                flag.store(true, Ordering::SeqCst);
            })
        })
    }

    /// (a) register then guard.cancelled() is false
    #[tokio::test]
    async fn register_then_not_cancelled() {
        let registry = RunningQueryRegistry::new();
        let token = Uuid::new_v4();
        let guard = registry.register(token, noop_action()).await;
        assert!(!guard.cancelled());
    }

    /// (b) request_cancel sets the flag so a held guard reports cancelled() true
    #[tokio::test]
    async fn request_cancel_sets_flag() {
        let registry = RunningQueryRegistry::new();
        let token = Uuid::new_v4();
        let guard = registry.register(token, noop_action()).await;
        assert!(!guard.cancelled());
        registry.request_cancel(token).await;
        assert!(guard.cancelled());
    }

    /// (c) request_cancel on an unknown token is a no-op that does not panic
    #[tokio::test]
    async fn request_cancel_unknown_token_noop() {
        let registry = RunningQueryRegistry::new();
        let unknown = Uuid::new_v4();
        // Should not panic
        registry.request_cancel(unknown).await;
    }

    /// (d) cancel-before-register (tombstone): request_cancel(token) then
    /// register(token, action) → the returned guard reports cancelled() true
    /// and the action fires.
    #[tokio::test]
    async fn cancel_before_register_tombstone() {
        let registry = RunningQueryRegistry::new();
        let token = Uuid::new_v4();

        // Cancel before register — creates a tombstone
        registry.request_cancel(token).await;

        // Now register — action should fire immediately
        let action_fired = Arc::new(AtomicBool::new(false));
        let guard = registry.register(token, flag_action(action_fired.clone())).await;

        // Guard should already be cancelled
        assert!(guard.cancelled());
        // Action should have fired
        assert!(action_fired.load(Ordering::SeqCst));
    }
}
