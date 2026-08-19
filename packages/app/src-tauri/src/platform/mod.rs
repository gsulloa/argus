pub mod connection_groups;
pub mod connections;
pub mod open_connections;
pub mod row_cap;
pub mod secrets;
pub mod settings;
pub mod sql_limit;
pub mod storage;
pub mod updater;

use std::sync::Mutex;

use rusqlite::Connection;

pub struct DbState(pub Mutex<Connection>);
