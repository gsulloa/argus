pub mod connection_groups;
pub mod connections;
pub mod secrets;
pub mod settings;
pub mod storage;
pub mod updater;

use std::sync::Mutex;

use rusqlite::Connection;

pub struct DbState(pub Mutex<Connection>);
