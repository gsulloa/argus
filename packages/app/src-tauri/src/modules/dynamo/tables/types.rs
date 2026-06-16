use serde::Serialize;

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/// Table billing mode, serialised as AWS literal strings.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BillingMode {
    PayPerRequest,
    Provisioned,
}

/// Table status, serialised as AWS literal strings.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub enum TableStatus {
    #[serde(rename = "ACTIVE")]
    Active,
    #[serde(rename = "CREATING")]
    Creating,
    #[serde(rename = "UPDATING")]
    Updating,
    #[serde(rename = "DELETING")]
    Deleting,
    #[serde(rename = "INACCESSIBLE_ENCRYPTION_CREDENTIALS")]
    InaccessibleEncryptionCredentials,
    #[serde(rename = "ARCHIVING")]
    Archiving,
    #[serde(rename = "ARCHIVED")]
    Archived,
    /// Forward-compatible catch-all — the raw AWS string is preserved.
    #[serde(rename = "UNKNOWN")]
    Unknown,
}

/// Key type: HASH or RANGE.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum KeyType {
    Hash,
    Range,
}

/// Attribute scalar type: S / N / B.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AttributeType {
    S,
    N,
    B,
}

// ---------------------------------------------------------------------------
// Key + attribute sub-types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct KeySchemaElement {
    pub attribute_name: String,
    pub key_type: KeyType,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AttributeDefinitionInfo {
    pub attribute_name: String,
    pub attribute_type: AttributeType,
}

// ---------------------------------------------------------------------------
// Provisioned throughput info (used inside GSI)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ProvisionedThroughputInfo {
    pub read_capacity_units: i64,
    pub write_capacity_units: i64,
}

// ---------------------------------------------------------------------------
// Index types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GsiInfo {
    pub index_name: String,
    pub key_schema: Vec<KeySchemaElement>,
    pub projection_type: String,
    pub index_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provisioned_throughput: Option<ProvisionedThroughputInfo>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LsiInfo {
    pub index_name: String,
    pub key_schema: Vec<KeySchemaElement>,
    pub projection_type: String,
}

// ---------------------------------------------------------------------------
// Stream specification
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct StreamSpecificationInfo {
    pub stream_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_view_type: Option<String>,
}

// ---------------------------------------------------------------------------
// Top-level table description envelope
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TableDescription {
    pub table_name: String,
    pub table_arn: String,
    pub table_status: TableStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creation_date_time: Option<String>,
    pub item_count: u64,
    pub table_size_bytes: u64,
    pub billing_mode: BillingMode,
    pub key_schema: Vec<KeySchemaElement>,
    pub attribute_definitions: Vec<AttributeDefinitionInfo>,
    pub global_secondary_indexes: Vec<GsiInfo>,
    pub local_secondary_indexes: Vec<LsiInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_specification: Option<StreamSpecificationInfo>,
}

// ---------------------------------------------------------------------------
// listTables result envelope
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ListTablesResult {
    pub tables: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_token: Option<String>,
    pub truncated: bool,
}

// ---------------------------------------------------------------------------
// Unit tests: serialization shape
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn billing_mode_pay_per_request_serializes_as_screaming_snake() {
        let v = serde_json::to_value(&BillingMode::PayPerRequest).unwrap();
        assert_eq!(v, "PAY_PER_REQUEST");
    }

    #[test]
    fn billing_mode_provisioned_serializes_correctly() {
        let v = serde_json::to_value(&BillingMode::Provisioned).unwrap();
        assert_eq!(v, "PROVISIONED");
    }

    #[test]
    fn table_status_active_serializes_correctly() {
        let v = serde_json::to_value(&TableStatus::Active).unwrap();
        assert_eq!(v, "ACTIVE");
    }

    #[test]
    fn table_status_inaccessible_encryption_serializes_correctly() {
        let v = serde_json::to_value(&TableStatus::InaccessibleEncryptionCredentials).unwrap();
        assert_eq!(v, "INACCESSIBLE_ENCRYPTION_CREDENTIALS");
    }

    #[test]
    fn key_type_hash_serializes_as_hash() {
        let v = serde_json::to_value(&KeyType::Hash).unwrap();
        assert_eq!(v, "HASH");
    }

    #[test]
    fn key_type_range_serializes_as_range() {
        let v = serde_json::to_value(&KeyType::Range).unwrap();
        assert_eq!(v, "RANGE");
    }

    #[test]
    fn attribute_type_s_serializes_as_s() {
        let v = serde_json::to_value(&AttributeType::S).unwrap();
        assert_eq!(v, "S");
    }

    #[test]
    fn list_tables_result_omits_next_token_when_not_truncated() {
        let result = ListTablesResult {
            tables: vec!["a".into()],
            next_token: None,
            truncated: false,
        };
        let v = serde_json::to_value(&result).unwrap();
        assert!(v.get("next_token").is_none());
        assert_eq!(v["truncated"], false);
    }

    #[test]
    fn list_tables_result_includes_next_token_when_truncated() {
        let result = ListTablesResult {
            tables: vec!["a".into()],
            next_token: Some("tbl-999".into()),
            truncated: true,
        };
        let v = serde_json::to_value(&result).unwrap();
        assert_eq!(v["next_token"], "tbl-999");
        assert_eq!(v["truncated"], true);
    }

    #[test]
    fn stream_spec_omits_view_type_when_none() {
        let s = StreamSpecificationInfo {
            stream_enabled: true,
            stream_view_type: None,
        };
        let v = serde_json::to_value(&s).unwrap();
        assert!(v.get("stream_view_type").is_none());
    }

    #[test]
    fn gsi_info_omits_provisioned_throughput_when_none() {
        let g = GsiInfo {
            index_name: "idx".into(),
            key_schema: vec![],
            projection_type: "ALL".into(),
            index_status: "ACTIVE".into(),
            provisioned_throughput: None,
        };
        let v = serde_json::to_value(&g).unwrap();
        assert!(v.get("provisioned_throughput").is_none());
    }
}
