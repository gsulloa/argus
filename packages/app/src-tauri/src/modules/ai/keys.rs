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
//
// The store is **thread-local**, not a shared global: the libtest harness runs
// each test on its own thread, and `#[tokio::test]` uses a current-thread
// runtime that keeps all tasks (including `tokio::spawn`ed ones) on that thread.
// A thread-local store therefore gives every test its own isolated keychain, so
// tests that mutate the same account (e.g. `ai:anthropic`) in parallel cannot
// race on each other's `set`/`delete`.
#[cfg(test)]
mod backend {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    thread_local! {
        static STORE: RefCell<HashMap<String, String>> = RefCell::new(HashMap::new());
    }

    pub fn get(account: &str) -> AppResult<Option<String>> {
        Ok(STORE.with(|s| s.borrow().get(account).cloned()))
    }

    pub fn set(account: &str, secret: &str) -> AppResult<()> {
        STORE.with(|s| {
            s.borrow_mut()
                .insert(account.to_string(), secret.to_string())
        });
        Ok(())
    }

    pub fn delete(account: &str) -> AppResult<()> {
        STORE.with(|s| s.borrow_mut().remove(account));
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
