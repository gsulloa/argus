pub mod commands;
pub mod describe;
pub mod list;
pub mod types;

// Re-export public surface for callers.
pub use commands::{dynamo_describe_table, dynamo_list_tables};
pub use types::{GsiInfo, LsiInfo, StreamSpecificationInfo, TableDescription};
