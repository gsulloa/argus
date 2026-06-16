// `mod backend` is a cfg(test)/cfg(not(test)) replacement pair, not a unit-test
// module — the items_after_test_module lint mistakes it for one.
#![allow(clippy::items_after_test_module)]

use uuid::Uuid;

#[cfg(not(test))]
use crate::error::AppError;
use crate::error::AppResult;

// migration-sensitive: keychain service name; see config::app_identity::KEYCHAIN_SERVICE.
#[cfg(not(test))]
const SERVICE: &str = crate::config::app_identity::KEYCHAIN_SERVICE;

fn account(id: &Uuid) -> String {
    format!("connection:{id}")
}

mod cache {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use uuid::Uuid;

    static CACHE: OnceLock<Mutex<HashMap<Uuid, Option<String>>>> = OnceLock::new();

    fn map() -> &'static Mutex<HashMap<Uuid, Option<String>>> {
        CACHE.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// Outer `Option` distinguishes "absent from cache" (None) from "cached as
    /// no-secret" (`Some(None)`). The inner Option mirrors `secrets::get`'s
    /// shape so callers can return the cached value verbatim.
    pub fn peek(id: &Uuid) -> Option<Option<String>> {
        map()
            .lock()
            .expect("secret cache poisoned")
            .get(id)
            .cloned()
    }

    pub fn insert(id: Uuid, value: Option<String>) {
        map()
            .lock()
            .expect("secret cache poisoned")
            .insert(id, value);
    }

    pub fn remove(id: &Uuid) {
        map().lock().expect("secret cache poisoned").remove(id);
    }
}

#[cfg(not(test))]
mod backend {
    use super::*;

    pub fn entry(id: &Uuid) -> AppResult<keyring::Entry> {
        keyring::Entry::new(SERVICE, &account(id)).map_err(AppError::from)
    }

    pub fn set(id: &Uuid, secret: &str) -> AppResult<()> {
        entry(id)?.set_password(secret).map_err(AppError::from)
    }

    pub fn get(id: &Uuid) -> AppResult<Option<String>> {
        match entry(id)?.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(AppError::from(e)),
        }
    }

    pub fn delete(id: &Uuid) -> AppResult<()> {
        match entry(id)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::from(e)),
        }
    }
}

#[cfg(test)]
mod backend {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    static STORE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    // Per-id so cache tests can observe "did `get` reach the backend for *my*
    // id?" without colliding with concurrent tests that touch other ids.
    static CALL_COUNTS: OnceLock<Mutex<HashMap<Uuid, usize>>> = OnceLock::new();

    fn store() -> &'static Mutex<HashMap<String, String>> {
        STORE.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn counts() -> &'static Mutex<HashMap<Uuid, usize>> {
        CALL_COUNTS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    pub fn set(id: &Uuid, secret: &str) -> AppResult<()> {
        store()
            .lock()
            .unwrap()
            .insert(account(id), secret.to_string());
        Ok(())
    }

    pub fn get(id: &Uuid) -> AppResult<Option<String>> {
        *counts().lock().unwrap().entry(*id).or_insert(0) += 1;
        Ok(store().lock().unwrap().get(&account(id)).cloned())
    }

    pub fn delete(id: &Uuid) -> AppResult<()> {
        store().lock().unwrap().remove(&account(id));
        Ok(())
    }

    pub fn _get_call_count_for_tests(id: &Uuid) -> usize {
        counts().lock().unwrap().get(id).copied().unwrap_or(0)
    }
}

pub fn get(id: &Uuid) -> AppResult<Option<String>> {
    if let Some(hit) = cache::peek(id) {
        return Ok(hit);
    }
    let v = backend::get(id)?;
    cache::insert(*id, v.clone());
    Ok(v)
}

pub fn set(id: &Uuid, secret: &str) -> AppResult<()> {
    backend::set(id, secret)?;
    cache::insert(*id, Some(secret.to_string()));
    Ok(())
}

pub fn delete(id: &Uuid) -> AppResult<()> {
    backend::delete(id)?;
    cache::remove(id);
    Ok(())
}

pub fn refresh(id: &Uuid) -> AppResult<Option<String>> {
    cache::remove(id);
    get(id)
}

#[cfg(test)]
pub use backend::_get_call_count_for_tests;

/// Test-only helper that writes directly to the backend, bypassing the cache
/// wrapper. Used to simulate an external keychain mutation (e.g., the user
/// edits the password in macOS Keychain Access while Argus is running) so
/// `refresh` paths can be exercised end-to-end.
#[cfg(test)]
pub fn _backend_set_for_tests(id: &Uuid, secret: &str) -> AppResult<()> {
    backend::set(id, secret)
}

#[cfg(test)]
mod cache_tests {
    use super::*;

    #[test]
    fn cold_miss_reads_backend_and_populates_cache() {
        let id = Uuid::new_v4();
        backend::set(&id, "alpha").unwrap();
        let before = _get_call_count_for_tests(&id);
        let v = get(&id).unwrap();
        let after = _get_call_count_for_tests(&id);
        assert_eq!(v.as_deref(), Some("alpha"));
        assert_eq!(after - before, 1);
        assert_eq!(cache::peek(&id), Some(Some("alpha".into())));
    }

    #[test]
    fn warm_hit_does_not_invoke_backend() {
        let id = Uuid::new_v4();
        backend::set(&id, "beta").unwrap();
        // Warm up.
        get(&id).unwrap();
        let before = _get_call_count_for_tests(&id);
        let v = get(&id).unwrap();
        let after = _get_call_count_for_tests(&id);
        assert_eq!(v.as_deref(), Some("beta"));
        assert_eq!(after - before, 0);
    }

    #[test]
    fn negative_caching_does_not_re_query_backend() {
        let id = Uuid::new_v4();
        let v1 = get(&id).unwrap();
        let after_first = _get_call_count_for_tests(&id);
        let v2 = get(&id).unwrap();
        let after_second = _get_call_count_for_tests(&id);
        assert_eq!(v1, None);
        assert_eq!(v2, None);
        assert_eq!(after_second - after_first, 0);
    }

    #[test]
    fn set_writes_backend_and_populates_cache() {
        let id = Uuid::new_v4();
        set(&id, "gamma").unwrap();
        // Direct backend probe to confirm write-through (this also bumps the
        // call counter for `id`, so we baseline AFTER the probe).
        assert_eq!(backend::get(&id).unwrap().as_deref(), Some("gamma"));
        assert_eq!(cache::peek(&id), Some(Some("gamma".into())));
        let before = _get_call_count_for_tests(&id);
        let v = get(&id).unwrap();
        let after = _get_call_count_for_tests(&id);
        assert_eq!(v.as_deref(), Some("gamma"));
        assert_eq!(after - before, 0);
    }

    #[test]
    fn delete_evicts_cache_and_re_reads_backend_as_none() {
        let id = Uuid::new_v4();
        set(&id, "delta").unwrap();
        get(&id).unwrap();
        delete(&id).unwrap();
        assert_eq!(cache::peek(&id), None);
        let v = get(&id).unwrap();
        assert_eq!(v, None);
        assert_eq!(cache::peek(&id), Some(None));
    }

    #[test]
    fn refresh_evicts_and_re_reads() {
        let id = Uuid::new_v4();
        set(&id, "old").unwrap();
        get(&id).unwrap();
        // Simulate an external mutation: write directly to the backend
        // bypassing the cache wrapper.
        backend::set(&id, "new").unwrap();
        assert_eq!(cache::peek(&id), Some(Some("old".into())));
        let v = refresh(&id).unwrap();
        assert_eq!(v.as_deref(), Some("new"));
        assert_eq!(cache::peek(&id), Some(Some("new".into())));
    }

    #[test]
    fn refresh_for_unknown_id_returns_none() {
        let id = Uuid::new_v4();
        let v = refresh(&id).unwrap();
        assert_eq!(v, None);
        assert_eq!(cache::peek(&id), Some(None));
    }
}
