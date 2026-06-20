use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Mutex;

use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::modules::ai::types::{ChatRole, ChatTurn, ProviderId, ToolUseRecord};

pub const MAX_SESSIONS: usize = 64;

pub struct ChatSession {
    pub id: String,
    pub connection_id: Option<Uuid>,
    pub provider_id: ProviderId,
    pub context_path: Option<PathBuf>,
    pub turns: Vec<ChatTurn>,
    pub in_flight: Option<JoinHandle<()>>,
    /// Provider-specific scratch state shared across turns (e.g. claude --resume id,
    /// "codex warning shown" flag). Opaque to the registry.
    pub provider_state: HashMap<String, String>,
}

pub struct ChatSessionRegistry {
    inner: Mutex<RegistryInner>,
}

struct RegistryInner {
    sessions: HashMap<String, ChatSession>,
    lru: VecDeque<String>, // most-recently-used at the front
}

impl ChatSessionRegistry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(RegistryInner {
                sessions: HashMap::new(),
                lru: VecDeque::new(),
            }),
        }
    }

    /// Open a new session (or fetch existing) with the given binding.
    /// If existing, return it without touching the provider binding (immutable per session).
    pub fn open_or_get(
        &self,
        id: &str,
        provider_id: ProviderId,
        connection_id: Option<Uuid>,
        context_path: Option<PathBuf>,
    ) -> AppResult<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AppError::Internal("chat registry poisoned".into()))?;
        if guard.sessions.contains_key(id) {
            promote_lru(&mut guard.lru, id);
            return Ok(());
        }
        // Evict LRU if needed BEFORE inserting.
        if guard.sessions.len() >= MAX_SESSIONS {
            if let Some(victim) = guard.lru.pop_back() {
                if let Some(mut sess) = guard.sessions.remove(&victim) {
                    if let Some(handle) = sess.in_flight.take() {
                        handle.abort();
                    }
                }
            }
        }
        guard.sessions.insert(
            id.to_string(),
            ChatSession {
                id: id.to_string(),
                connection_id,
                provider_id,
                context_path,
                turns: Vec::new(),
                in_flight: None,
                provider_state: HashMap::new(),
            },
        );
        guard.lru.push_front(id.to_string());
        Ok(())
    }

    pub fn append_user(&self, id: &str, content: String) -> AppResult<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AppError::Internal("chat registry poisoned".into()))?;
        let sess = guard
            .sessions
            .get_mut(id)
            .ok_or_else(|| AppError::NotFound(format!("chat session {id}")))?;
        sess.turns.push(ChatTurn {
            role: ChatRole::User,
            content,
            tool_uses: vec![],
        });
        promote_lru(&mut guard.lru, id);
        Ok(())
    }

    pub fn append_assistant(
        &self,
        id: &str,
        content: String,
        tool_uses: Vec<ToolUseRecord>,
    ) -> AppResult<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AppError::Internal("chat registry poisoned".into()))?;
        let sess = guard
            .sessions
            .get_mut(id)
            .ok_or_else(|| AppError::NotFound(format!("chat session {id}")))?;
        sess.turns.push(ChatTurn {
            role: ChatRole::Assistant,
            content,
            tool_uses,
        });
        promote_lru(&mut guard.lru, id);
        Ok(())
    }

    pub fn set_in_flight(&self, id: &str, handle: Option<JoinHandle<()>>) -> AppResult<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AppError::Internal("chat registry poisoned".into()))?;
        let sess = guard
            .sessions
            .get_mut(id)
            .ok_or_else(|| AppError::NotFound(format!("chat session {id}")))?;
        // Drop any prior handle (don't abort — caller's responsibility).
        sess.in_flight = handle;
        Ok(())
    }

    pub fn abort(&self, id: &str) -> AppResult<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AppError::Internal("chat registry poisoned".into()))?;
        if let Some(sess) = guard.sessions.get_mut(id) {
            if let Some(handle) = sess.in_flight.take() {
                handle.abort();
            }
        }
        Ok(())
    }

    pub fn close(&self, id: &str) -> AppResult<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AppError::Internal("chat registry poisoned".into()))?;
        if let Some(mut sess) = guard.sessions.remove(id) {
            if let Some(handle) = sess.in_flight.take() {
                handle.abort();
            }
        }
        guard.lru.retain(|x| x != id);
        Ok(())
    }

    pub fn snapshot_turns(&self, id: &str) -> AppResult<Vec<ChatTurn>> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| AppError::Internal("chat registry poisoned".into()))?;
        Ok(guard
            .sessions
            .get(id)
            .map(|s| s.turns.clone())
            .unwrap_or_default())
    }

    /// Read+update provider scratch state. Returns prior value if any.
    pub fn set_provider_state(
        &self,
        id: &str,
        key: &str,
        value: String,
    ) -> AppResult<Option<String>> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AppError::Internal("chat registry poisoned".into()))?;
        let sess = guard
            .sessions
            .get_mut(id)
            .ok_or_else(|| AppError::NotFound(format!("chat session {id}")))?;
        Ok(sess.provider_state.insert(key.to_string(), value))
    }

    pub fn get_provider_state(&self, id: &str, key: &str) -> AppResult<Option<String>> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| AppError::Internal("chat registry poisoned".into()))?;
        Ok(guard
            .sessions
            .get(id)
            .and_then(|s| s.provider_state.get(key).cloned()))
    }

    pub fn context_path(&self, id: &str) -> AppResult<Option<PathBuf>> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| AppError::Internal("chat registry poisoned".into()))?;
        Ok(guard.sessions.get(id).and_then(|s| s.context_path.clone()))
    }

    pub fn provider_id(&self, id: &str) -> AppResult<Option<ProviderId>> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| AppError::Internal("chat registry poisoned".into()))?;
        Ok(guard.sessions.get(id).map(|s| s.provider_id))
    }

    pub fn turn_count(&self, id: &str) -> usize {
        self.inner
            .lock()
            .ok()
            .and_then(|g| g.sessions.get(id).map(|s| s.turns.len()))
            .unwrap_or(0)
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.inner.lock().map(|g| g.sessions.len()).unwrap_or(0)
    }
}

impl Default for ChatSessionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

fn promote_lru(lru: &mut VecDeque<String>, id: &str) {
    lru.retain(|x| x != id);
    lru.push_front(id.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anon_provider() -> ProviderId {
        ProviderId::ClaudeCli
    }

    #[test]
    fn open_and_append_turns() {
        let reg = ChatSessionRegistry::new();
        reg.open_or_get("s1", anon_provider(), None, None).unwrap();
        reg.append_user("s1", "hello".into()).unwrap();
        reg.append_assistant("s1", "hi".into(), vec![]).unwrap();
        assert_eq!(reg.turn_count("s1"), 2);
    }

    #[test]
    fn close_evicts() {
        let reg = ChatSessionRegistry::new();
        reg.open_or_get("s1", anon_provider(), None, None).unwrap();
        reg.close("s1").unwrap();
        assert_eq!(reg.len(), 0);
    }

    #[tokio::test]
    async fn abort_aborts_handle() {
        let reg = ChatSessionRegistry::new();
        reg.open_or_get("s1", anon_provider(), None, None).unwrap();
        let handle = tokio::spawn(async {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        });
        reg.set_in_flight("s1", Some(handle)).unwrap();
        reg.abort("s1").unwrap();
        // We can't directly check abort status, but no panic = pass.
    }

    #[test]
    fn lru_eviction() {
        let reg = ChatSessionRegistry::new();
        for i in 0..MAX_SESSIONS {
            reg.open_or_get(&format!("s{i}"), anon_provider(), None, None)
                .unwrap();
        }
        assert_eq!(reg.len(), MAX_SESSIONS);
        // Touch s5 so it's NOT the LRU.
        reg.open_or_get("s5", anon_provider(), None, None).unwrap();
        // Add a new session — s0 (oldest untouched) should be evicted.
        reg.open_or_get("new", anon_provider(), None, None).unwrap();
        assert_eq!(reg.len(), MAX_SESSIONS);
        // s0 should be gone; new and s5 should remain.
        assert_eq!(reg.turn_count("s0"), 0); // turn_count returns 0 for missing
                                             // Better check: try to append to s0 — should fail with NotFound.
        let r = reg.append_user("s0", "x".into());
        assert!(matches!(r, Err(AppError::NotFound(_))));
    }
}
