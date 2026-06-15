// `mod backend` is a cfg(test)/cfg(not(test)) replacement pair — the
// items_after_test_module lint mistakes it for one.
#![allow(clippy::items_after_test_module)]

use crate::error::AppResult;

pub const ACCOUNT_ANTHROPIC: &str = "ai:anthropic";
pub const ACCOUNT_OPENAI: &str = "ai:openai";

#[cfg(not(test))]
use crate::error::AppError;

// migration-sensitive: keychain service name; see config::app_identity::KEYCHAIN_SERVICE.
// (Accounts ACCOUNT_ANTHROPIC / ACCOUNT_OPENAI above are also migration-sensitive.)
#[cfg(not(test))]
const SERVICE: &str = crate::config::app_identity::KEYCHAIN_SERVICE;

#[cfg(not(test))]
mod backend {
    use super::*;

    fn entry(account: &str) -> AppResult<keyring::Entry> {
        keyring::Entry::new(SERVICE, account).map_err(AppError::from)
    }

    pub fn get(account: &str) -> AppResult<Option<String>> {
        match entry(account)?.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(AppError::from(e)),
        }
    }

    pub fn set(account: &str, secret: &str) -> AppResult<()> {
        entry(account)?.set_password(secret).map_err(AppError::from)
    }

    pub fn delete(account: &str) -> AppResult<()> {
        match entry(account)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::from(e)),
        }
    }
}

// In tests we use an in-memory store so tests are hermetic and deterministic.
#[cfg(test)]
mod backend {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    static STORE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

    fn store() -> &'static Mutex<HashMap<String, String>> {
        STORE.get_or_init(|| Mutex::new(HashMap::new()))
    }

    pub fn get(account: &str) -> AppResult<Option<String>> {
        Ok(store().lock().unwrap().get(account).cloned())
    }

    pub fn set(account: &str, secret: &str) -> AppResult<()> {
        store()
            .lock()
            .unwrap()
            .insert(account.to_string(), secret.to_string());
        Ok(())
    }

    pub fn delete(account: &str) -> AppResult<()> {
        store().lock().unwrap().remove(account);
        Ok(())
    }
}

pub fn get(account: &str) -> AppResult<Option<String>> {
    backend::get(account)
}

pub fn set(account: &str, secret: &str) -> AppResult<()> {
    backend::set(account, secret)
}

pub fn delete(account: &str) -> AppResult<()> {
    backend::delete(account)
}
