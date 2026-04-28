// `mod backend` is a cfg(test)/cfg(not(test)) replacement pair, not a unit-test
// module — the items_after_test_module lint mistakes it for one.
#![allow(clippy::items_after_test_module)]

#[cfg(not(test))]
use crate::error::AppError;
use crate::error::AppResult;

#[cfg(not(test))]
const SERVICE: &str = "argus";

fn account(id: &uuid::Uuid) -> String {
    format!("connection:{id}")
}

#[cfg(not(test))]
mod backend {
    use super::*;

    pub fn entry(id: &uuid::Uuid) -> AppResult<keyring::Entry> {
        keyring::Entry::new(SERVICE, &account(id)).map_err(AppError::from)
    }

    pub fn set(id: &uuid::Uuid, secret: &str) -> AppResult<()> {
        entry(id)?.set_password(secret).map_err(AppError::from)
    }

    pub fn get(id: &uuid::Uuid) -> AppResult<Option<String>> {
        match entry(id)?.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(AppError::from(e)),
        }
    }

    pub fn delete(id: &uuid::Uuid) -> AppResult<()> {
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
    use std::sync::Mutex;

    static STORE: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

    fn with_store<R>(f: impl FnOnce(&mut HashMap<String, String>) -> R) -> R {
        let mut guard = STORE.lock().unwrap();
        let map = guard.get_or_insert_with(HashMap::new);
        f(map)
    }

    pub fn set(id: &uuid::Uuid, secret: &str) -> AppResult<()> {
        with_store(|m| {
            m.insert(account(id), secret.to_string());
        });
        Ok(())
    }

    pub fn get(id: &uuid::Uuid) -> AppResult<Option<String>> {
        Ok(with_store(|m| m.get(&account(id)).cloned()))
    }

    pub fn delete(id: &uuid::Uuid) -> AppResult<()> {
        with_store(|m| {
            m.remove(&account(id));
        });
        Ok(())
    }

    pub fn _clear_for_tests() {
        with_store(|m| m.clear());
    }
}

#[cfg(test)]
pub use backend::_clear_for_tests;
pub use backend::{delete, get, set};
