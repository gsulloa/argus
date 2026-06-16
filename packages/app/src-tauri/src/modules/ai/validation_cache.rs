use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::modules::ai::types::{ProviderId, ValidationResult};

const TTL: Duration = Duration::from_secs(60);

pub struct ValidationCache {
    entries: Mutex<HashMap<ProviderId, (ValidationResult, Instant)>>,
}

impl ValidationCache {
    pub fn new() -> Self {
        Self { entries: Mutex::new(HashMap::new()) }
    }

    pub fn peek(&self, id: ProviderId) -> Option<ValidationResult> {
        let map = self.entries.lock().ok()?;
        let (res, at) = map.get(&id)?;
        if at.elapsed() < TTL { Some(res.clone()) } else { None }
    }

    pub fn insert(&self, id: ProviderId, result: ValidationResult) {
        if let Ok(mut map) = self.entries.lock() {
            map.insert(id, (result, Instant::now()));
        }
    }

    pub fn invalidate(&self, id: ProviderId) {
        if let Ok(mut map) = self.entries.lock() {
            map.remove(&id);
        }
    }

    pub fn invalidate_all(&self) {
        if let Ok(mut map) = self.entries.lock() {
            map.clear();
        }
    }
}

impl Default for ValidationCache {
    fn default() -> Self {
        Self::new()
    }
}
