use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::modules::ai::types::{ModelListing, ProviderId};

/// TTL for model listing cache entries. Model lists change far less often than
/// credential validity, so 5 minutes is safe and avoids unnecessary round-trips.
const TTL: Duration = Duration::from_secs(300);

/// In-memory TTL cache for per-provider `ModelListing` results.
///
/// Mirrors `ValidationCache` but for model discovery. Registered as Tauri
/// managed state. Thread-safe via `Mutex`.
pub struct ModelCache {
    entries: Mutex<HashMap<ProviderId, (ModelListing, Instant)>>,
}

impl ModelCache {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Return a clone of the cached listing for `id` if it exists and has not
    /// yet expired. Returns `None` when the entry is absent or stale.
    pub fn peek(&self, id: ProviderId) -> Option<ModelListing> {
        let map = self.entries.lock().ok()?;
        let (listing, at) = map.get(&id)?;
        if at.elapsed() < TTL {
            Some(listing.clone())
        } else {
            None
        }
    }

    /// Store `listing` for `id`, resetting its TTL clock.
    pub fn insert(&self, id: ProviderId, listing: ModelListing) {
        if let Ok(mut map) = self.entries.lock() {
            map.insert(id, (listing, Instant::now()));
        }
    }

    /// Remove the cache entry for `id`, forcing the next `ai_list_providers`
    /// call to re-fetch.
    pub fn invalidate(&self, id: ProviderId) {
        if let Ok(mut map) = self.entries.lock() {
            map.remove(&id);
        }
    }

    /// Clear all cached entries (e.g. on settings change).
    pub fn invalidate_all(&self) {
        if let Ok(mut map) = self.entries.lock() {
            map.clear();
        }
    }
}

impl Default for ModelCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::ai::types::{ModelSource, ProviderId};

    fn sample_listing(source: ModelSource) -> ModelListing {
        ModelListing {
            models: vec!["claude-opus-4-8".to_string()],
            source,
            refreshed_at: Some(1_700_000_000_000),
            error: None,
        }
    }

    #[test]
    fn cached_entry_served_within_ttl() {
        let cache = ModelCache::new();
        let id = ProviderId::AnthropicApi;
        let listing = sample_listing(ModelSource::Provider);

        assert!(cache.peek(id).is_none(), "cache should start empty");

        cache.insert(id, listing.clone());
        let hit = cache.peek(id).expect("should have a cached entry");
        assert_eq!(hit.source, ModelSource::Provider);
        assert_eq!(hit.models, listing.models);
        assert_eq!(hit.refreshed_at, listing.refreshed_at);
    }

    #[test]
    fn invalidate_removes_single_entry() {
        let cache = ModelCache::new();
        let anthropic = ProviderId::AnthropicApi;
        let openai = ProviderId::OpenAiApi;

        cache.insert(anthropic, sample_listing(ModelSource::Provider));
        cache.insert(openai, sample_listing(ModelSource::Cache));

        cache.invalidate(anthropic);

        assert!(
            cache.peek(anthropic).is_none(),
            "anthropic entry should be gone"
        );
        assert!(
            cache.peek(openai).is_some(),
            "openai entry should still be present"
        );
    }

    #[test]
    fn invalidate_all_clears_cache() {
        let cache = ModelCache::new();
        cache.insert(
            ProviderId::AnthropicApi,
            sample_listing(ModelSource::Provider),
        );
        cache.insert(ProviderId::OpenAiApi, sample_listing(ModelSource::Fallback));
        cache.insert(ProviderId::ClaudeCli, sample_listing(ModelSource::Fallback));

        cache.invalidate_all();

        for id in ProviderId::ALL {
            assert!(
                cache.peek(id).is_none(),
                "entry for {id:?} should be cleared"
            );
        }
    }

    #[test]
    fn insert_overwrites_existing_entry() {
        let cache = ModelCache::new();
        let id = ProviderId::OpenAiApi;

        cache.insert(id, sample_listing(ModelSource::Fallback));
        let first = cache.peek(id).unwrap();
        assert_eq!(first.source, ModelSource::Fallback);

        // Overwrite with a Provider-sourced listing.
        let fresh = ModelListing {
            models: vec!["gpt-5.1".to_string(), "gpt-4o".to_string()],
            source: ModelSource::Provider,
            refreshed_at: Some(1_700_000_001_000),
            error: None,
        };
        cache.insert(id, fresh.clone());
        let second = cache.peek(id).unwrap();
        assert_eq!(second.source, ModelSource::Provider);
        assert_eq!(second.models, fresh.models);
    }
}
