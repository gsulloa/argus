//! AWS Athena connection support.

pub mod client;
pub mod commands;
pub mod errors;
pub mod named_queries;
pub mod params;
pub mod pool;
pub mod s3;
pub mod schema_commands;
pub mod sql;

pub use pool::AthenaClientRegistry;
