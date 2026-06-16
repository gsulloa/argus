/// The data-source engine associated with a connection.
///
/// Used to determine which subtree of a context folder to read and which
/// query file extensions are valid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EngineKind {
    Athena,
    Postgres,
    Mysql,
    Mssql,
    Dynamo,
    Cloudwatch,
}

impl EngineKind {
    /// Map the `kind` string stored on a `Connection` to an `EngineKind`.
    pub fn from_connection_kind(kind: &str) -> Option<Self> {
        match kind {
            "athena" => Some(Self::Athena),
            "postgres" => Some(Self::Postgres),
            "mysql" => Some(Self::Mysql),
            "mssql" => Some(Self::Mssql),
            // Connections persist the Dynamo kind as "dynamodb" (see
            // modules/dynamo: DYNAMO_KIND). "dynamo" is accepted as a
            // defensive alias in case of older/migrated rows.
            "dynamodb" | "dynamo" => Some(Self::Dynamo),
            "cloudwatch" => Some(Self::Cloudwatch),
            _ => None,
        }
    }

    /// The subdirectory name under the context folder root for this engine.
    pub fn subtree(&self) -> &'static str {
        match self {
            Self::Athena => "athena",
            Self::Postgres => "postgres",
            Self::Mysql => "mysql",
            Self::Mssql => "mssql",
            Self::Dynamo => "dynamo",
            Self::Cloudwatch => "cloudwatch",
        }
    }

    /// Recognised body-file extensions inside this engine's `queries/` directory.
    pub fn query_extensions(&self) -> &'static [&'static str] {
        match self {
            Self::Postgres | Self::Mysql | Self::Mssql | Self::Athena => &["sql"],
            Self::Dynamo => &["partiql"],
            Self::Cloudwatch => &["cwlogs"],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_each_connection_kind_to_engine() {
        assert_eq!(
            EngineKind::from_connection_kind("athena"),
            Some(EngineKind::Athena)
        );
        assert_eq!(
            EngineKind::from_connection_kind("postgres"),
            Some(EngineKind::Postgres)
        );
        assert_eq!(
            EngineKind::from_connection_kind("mysql"),
            Some(EngineKind::Mysql)
        );
        assert_eq!(
            EngineKind::from_connection_kind("mssql"),
            Some(EngineKind::Mssql)
        );
        assert_eq!(
            EngineKind::from_connection_kind("cloudwatch"),
            Some(EngineKind::Cloudwatch)
        );
    }

    #[test]
    fn dynamo_connection_kind_is_dynamodb() {
        // Connections persist "dynamodb" (modules/dynamo: DYNAMO_KIND); the
        // legacy "dynamo" alias must also resolve. Regression for
        // "unsupported engine kind: dynamodb" when linking a context folder.
        assert_eq!(
            EngineKind::from_connection_kind("dynamodb"),
            Some(EngineKind::Dynamo)
        );
        assert_eq!(
            EngineKind::from_connection_kind("dynamo"),
            Some(EngineKind::Dynamo)
        );
    }

    #[test]
    fn unknown_kind_is_none() {
        assert_eq!(EngineKind::from_connection_kind("redis"), None);
    }
}
