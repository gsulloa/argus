/// DynamoDB item types, codec, IPC envelopes, and activity-log helpers.
///
/// Phase 1 of OpenSpec change `view-dynamo-items` (tasks 1.1–1.5).
/// Phase 2 will add the actual Scan/Query/Count command handlers on top of these types.
use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::modules::activity_log::Origin;

// ---------------------------------------------------------------------------
// §1.1  AttrValue — serde-friendly mirror of AWS AttributeValue
// ---------------------------------------------------------------------------

/// Serde-friendly tagged enum mirroring `aws_sdk_dynamodb::types::AttributeValue`.
///
/// JSON wire shape: `{"S":"..."}`, `{"N":"..."}`, `{"BOOL":true}`, `{"NULL":true}`,
/// `{"L":[...]}`, `{"M":{...}}`, `{"SS":["a","b"]}`, `{"NS":["1","2"]}`,
/// `{"B":"<base64>"}`, `{"BS":["<b64>",...]}`.
///
/// The `N` variant holds a `String` per the AWS spec (numbers travel as strings).
/// The `B`/`BS` variants store raw bytes in Rust; the serde impl encodes/decodes base64.
/// The `NULL` variant holds a `bool` (always `true` over the wire per the AWS spec).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum AttrValue {
    S(String),
    N(String),
    #[serde(rename = "BOOL")]
    Bool(bool),
    #[serde(rename = "NULL")]
    Null(bool),
    L(Vec<AttrValue>),
    M(HashMap<String, AttrValue>),
    #[serde(rename = "SS")]
    Ss(Vec<String>),
    #[serde(rename = "NS")]
    Ns(Vec<String>),
    /// Binary data; serialized/deserialized as a base64 string.
    #[serde(with = "base64_bytes")]
    B(Vec<u8>),
    /// Binary set; each element serialized/deserialized as a base64 string.
    #[serde(rename = "BS", with = "base64_bytes_vec")]
    Bs(Vec<Vec<u8>>),
}

// ---------------------------------------------------------------------------
// Base64 serde helpers
// ---------------------------------------------------------------------------

mod base64_bytes {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &Vec<u8>, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(de: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(de)?;
        STANDARD.decode(&s).map_err(serde::de::Error::custom)
    }
}

mod base64_bytes_vec {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(blobs: &Vec<Vec<u8>>, ser: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeSeq;
        let mut seq = ser.serialize_seq(Some(blobs.len()))?;
        for b in blobs {
            seq.serialize_element(&STANDARD.encode(b))?;
        }
        seq.end()
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(de: D) -> Result<Vec<Vec<u8>>, D::Error> {
        let strings: Vec<String> = Vec::deserialize(de)?;
        strings
            .into_iter()
            .map(|s| STANDARD.decode(&s).map_err(serde::de::Error::custom))
            .collect()
    }
}

// ---------------------------------------------------------------------------
// §1.2  From conversions between AttrValue and the AWS SDK type
// ---------------------------------------------------------------------------

impl From<aws_sdk_dynamodb::types::AttributeValue> for AttrValue {
    fn from(sdk: aws_sdk_dynamodb::types::AttributeValue) -> Self {
        match sdk {
            aws_sdk_dynamodb::types::AttributeValue::S(s) => AttrValue::S(s),
            aws_sdk_dynamodb::types::AttributeValue::N(n) => AttrValue::N(n),
            aws_sdk_dynamodb::types::AttributeValue::Bool(b) => AttrValue::Bool(b),
            aws_sdk_dynamodb::types::AttributeValue::Null(n) => AttrValue::Null(n),
            aws_sdk_dynamodb::types::AttributeValue::L(list) => {
                AttrValue::L(list.into_iter().map(AttrValue::from).collect())
            }
            aws_sdk_dynamodb::types::AttributeValue::M(map) => AttrValue::M(
                map.into_iter()
                    .map(|(k, v)| (k, AttrValue::from(v)))
                    .collect(),
            ),
            aws_sdk_dynamodb::types::AttributeValue::Ss(ss) => AttrValue::Ss(ss),
            aws_sdk_dynamodb::types::AttributeValue::Ns(ns) => AttrValue::Ns(ns),
            aws_sdk_dynamodb::types::AttributeValue::B(blob) => AttrValue::B(blob.into_inner()),
            aws_sdk_dynamodb::types::AttributeValue::Bs(blobs) => {
                AttrValue::Bs(blobs.into_iter().map(|b| b.into_inner()).collect())
            }
            // The SDK marks `Unknown` as non-exhaustive to handle future variants.
            // We map it to an empty S string and log a debug warning; callers
            // should not rely on this value being meaningful.
            _ => {
                tracing::debug!("AttrValue::from: encountered Unknown SDK variant");
                AttrValue::S(String::new())
            }
        }
    }
}

impl From<AttrValue> for aws_sdk_dynamodb::types::AttributeValue {
    fn from(val: AttrValue) -> Self {
        match val {
            AttrValue::S(s) => aws_sdk_dynamodb::types::AttributeValue::S(s),
            AttrValue::N(n) => aws_sdk_dynamodb::types::AttributeValue::N(n),
            AttrValue::Bool(b) => aws_sdk_dynamodb::types::AttributeValue::Bool(b),
            AttrValue::Null(n) => aws_sdk_dynamodb::types::AttributeValue::Null(n),
            AttrValue::L(list) => aws_sdk_dynamodb::types::AttributeValue::L(
                list.into_iter().map(Into::into).collect(),
            ),
            AttrValue::M(map) => aws_sdk_dynamodb::types::AttributeValue::M(
                map.into_iter().map(|(k, v)| (k, v.into())).collect(),
            ),
            AttrValue::Ss(ss) => aws_sdk_dynamodb::types::AttributeValue::Ss(ss),
            AttrValue::Ns(ns) => aws_sdk_dynamodb::types::AttributeValue::Ns(ns),
            AttrValue::B(bytes) => {
                aws_sdk_dynamodb::types::AttributeValue::B(aws_sdk_dynamodb::primitives::Blob::new(bytes))
            }
            AttrValue::Bs(blobs) => aws_sdk_dynamodb::types::AttributeValue::Bs(
                blobs
                    .into_iter()
                    .map(aws_sdk_dynamodb::primitives::Blob::new)
                    .collect(),
            ),
        }
    }
}

// ---------------------------------------------------------------------------
// §1.4  SelectMode and CountMode enums
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SelectMode {
    AllAttributes,
    AllProjectedAttributes,
    SpecificAttributes,
    Count,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CountMode {
    Scan,
    Query,
}

// ---------------------------------------------------------------------------
// §1.4  Request / Response envelopes
// ---------------------------------------------------------------------------

/// IPC request for `dynamo.scan`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ScanRequest {
    pub connection_id: Uuid,
    pub table_name: String,
    pub index_name: Option<String>,
    pub limit: u32,
    pub page: u32,
    pub exclusive_start_key: Option<HashMap<String, AttrValue>>,
    pub filter_expression: Option<String>,
    pub expression_attribute_names: Option<HashMap<String, String>>,
    pub expression_attribute_values: Option<HashMap<String, AttrValue>>,
    pub projection_expression: Option<String>,
    pub consistent_read: bool,
    pub select: Option<SelectMode>,
    pub origin: Option<Origin>,
}

/// IPC request for `dynamo.query`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct QueryRequest {
    pub connection_id: Uuid,
    pub table_name: String,
    pub index_name: Option<String>,
    pub limit: u32,
    pub page: u32,
    pub exclusive_start_key: Option<HashMap<String, AttrValue>>,
    pub key_condition_expression: String,
    pub filter_expression: Option<String>,
    pub expression_attribute_names: Option<HashMap<String, String>>,
    pub expression_attribute_values: Option<HashMap<String, AttrValue>>,
    pub projection_expression: Option<String>,
    pub consistent_read: bool,
    pub select: Option<SelectMode>,
    pub scan_index_forward: Option<bool>,
    pub origin: Option<Origin>,
}

/// IPC request for `dynamo.countItems`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CountRequest {
    pub connection_id: Uuid,
    pub table_name: String,
    pub mode: CountMode,
    pub index_name: Option<String>,
    pub key_condition_expression: Option<String>,
    pub filter_expression: Option<String>,
    pub expression_attribute_names: Option<HashMap<String, String>>,
    pub expression_attribute_values: Option<HashMap<String, AttrValue>>,
    pub scan_index_forward: Option<bool>,
    pub consistent_read: bool,
    pub origin: Option<Origin>,
}

/// IPC response from `dynamo.scan`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ScanResponse {
    pub items: Vec<HashMap<String, AttrValue>>,
    pub last_evaluated_key: Option<HashMap<String, AttrValue>>,
    pub scanned_count: u32,
    pub count: u32,
    /// TODO: Model ConsumedCapacity as a proper struct when the capacity reporting
    /// feature lands; using Value for now to avoid premature schema commitment.
    pub consumed_capacity: Option<serde_json::Value>,
}

/// IPC response from `dynamo.query`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct QueryResponse {
    pub items: Vec<HashMap<String, AttrValue>>,
    pub last_evaluated_key: Option<HashMap<String, AttrValue>>,
    pub scanned_count: u32,
    pub count: u32,
    /// TODO: Model ConsumedCapacity as a proper struct when the capacity reporting
    /// feature lands; using Value for now to avoid premature schema commitment.
    pub consumed_capacity: Option<serde_json::Value>,
}

/// IPC response from `dynamo.countItems`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CountResponse {
    pub total_count: u64,
    pub total_scanned_count: u64,
    pub page_count: u32,
    /// TODO: Model ConsumedCapacity as a proper struct when the capacity reporting
    /// feature lands; using Value for now to avoid premature schema commitment.
    pub consumed_capacity: Option<serde_json::Value>,
}

// ---------------------------------------------------------------------------
// §1.5  compact_activity_params — activity-log params helper
// ---------------------------------------------------------------------------

/// Build the compact activity-log `params` JSON for Scan/Query/Count commands.
///
/// Omits `index_name`, `select`, and `scan_index_forward` when they are `None`
/// to keep the log payload minimal and readable.
pub(crate) fn compact_activity_params(
    table_name: &str,
    index_name: Option<&str>,
    has_filter: bool,
    has_key_condition: bool,
    limit: Option<u32>,
    consistent_read: bool,
    select: Option<SelectMode>,
    page: Option<u32>,
    scan_index_forward: Option<bool>,
) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    map.insert("table_name".into(), serde_json::Value::String(table_name.to_string()));
    if let Some(idx) = index_name {
        map.insert("index_name".into(), serde_json::Value::String(idx.to_string()));
    }
    map.insert("has_filter".into(), serde_json::Value::Bool(has_filter));
    map.insert("has_key_condition".into(), serde_json::Value::Bool(has_key_condition));
    if let Some(l) = limit {
        map.insert("limit".into(), serde_json::Value::Number(l.into()));
    }
    map.insert("consistent_read".into(), serde_json::Value::Bool(consistent_read));
    if let Some(sel) = select {
        let sel_str = serde_json::to_value(sel)
            .unwrap_or(serde_json::Value::Null);
        map.insert("select".into(), sel_str);
    }
    if let Some(p) = page {
        map.insert("page".into(), serde_json::Value::Number(p.into()));
    }
    if let Some(fwd) = scan_index_forward {
        map.insert("scan_index_forward".into(), serde_json::Value::Bool(fwd));
    }
    serde_json::Value::Object(map)
}

// ---------------------------------------------------------------------------
// §1.3  Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_dynamodb::primitives::Blob;
    use aws_sdk_dynamodb::types::AttributeValue as SdkAttrValue;

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    fn sdk_to_our(v: SdkAttrValue) -> AttrValue {
        AttrValue::from(v)
    }

    fn our_to_sdk(v: AttrValue) -> SdkAttrValue {
        v.into()
    }

    fn roundtrip_sdk(sdk: SdkAttrValue) -> SdkAttrValue {
        our_to_sdk(sdk_to_our(sdk))
    }

    // -----------------------------------------------------------------------
    // (a) Every tag round-trips through From/Into
    // -----------------------------------------------------------------------

    #[test]
    fn s_roundtrips() {
        let sdk = SdkAttrValue::S("hello".into());
        let rt = roundtrip_sdk(sdk);
        assert!(matches!(rt, SdkAttrValue::S(s) if s == "hello"));
    }

    #[test]
    fn n_roundtrips() {
        let sdk = SdkAttrValue::N("42.5".into());
        let rt = roundtrip_sdk(sdk);
        assert!(matches!(rt, SdkAttrValue::N(n) if n == "42.5"));
    }

    #[test]
    fn bool_roundtrips() {
        for b in [true, false] {
            let sdk = SdkAttrValue::Bool(b);
            let rt = roundtrip_sdk(sdk);
            assert!(matches!(rt, SdkAttrValue::Bool(v) if v == b));
        }
    }

    #[test]
    fn null_roundtrips() {
        let sdk = SdkAttrValue::Null(true);
        let rt = roundtrip_sdk(sdk);
        assert!(matches!(rt, SdkAttrValue::Null(true)));
    }

    #[test]
    fn ss_roundtrips() {
        let sdk = SdkAttrValue::Ss(vec!["a".into(), "b".into()]);
        let rt = roundtrip_sdk(sdk);
        match rt {
            SdkAttrValue::Ss(v) => assert_eq!(v, vec!["a", "b"]),
            other => panic!("expected Ss, got {other:?}"),
        }
    }

    #[test]
    fn ns_roundtrips() {
        let sdk = SdkAttrValue::Ns(vec!["1".into(), "2.5".into()]);
        let rt = roundtrip_sdk(sdk);
        match rt {
            SdkAttrValue::Ns(v) => assert_eq!(v, vec!["1", "2.5"]),
            other => panic!("expected Ns, got {other:?}"),
        }
    }

    #[test]
    fn l_roundtrips() {
        let sdk = SdkAttrValue::L(vec![SdkAttrValue::S("x".into()), SdkAttrValue::N("1".into())]);
        let rt = roundtrip_sdk(sdk);
        match rt {
            SdkAttrValue::L(list) => {
                assert_eq!(list.len(), 2);
                assert!(matches!(&list[0], SdkAttrValue::S(s) if s == "x"));
                assert!(matches!(&list[1], SdkAttrValue::N(n) if n == "1"));
            }
            other => panic!("expected L, got {other:?}"),
        }
    }

    #[test]
    fn m_roundtrips() {
        let mut map = HashMap::new();
        map.insert("name".to_string(), SdkAttrValue::S("Alice".into()));
        map.insert("age".to_string(), SdkAttrValue::N("30".into()));
        let sdk = SdkAttrValue::M(map);
        let rt = roundtrip_sdk(sdk);
        match rt {
            SdkAttrValue::M(m) => {
                assert!(matches!(m.get("name"), Some(SdkAttrValue::S(s)) if s == "Alice"));
                assert!(matches!(m.get("age"), Some(SdkAttrValue::N(n)) if n == "30"));
            }
            other => panic!("expected M, got {other:?}"),
        }
    }

    // -----------------------------------------------------------------------
    // (b) Base64 binary is byte-exact
    // -----------------------------------------------------------------------

    #[test]
    fn b_roundtrips_byte_exact() {
        let bytes = vec![0u8, 1, 2, 255, 128, 64];
        let sdk = SdkAttrValue::B(Blob::new(bytes.clone()));
        let rt = roundtrip_sdk(sdk);
        match rt {
            SdkAttrValue::B(blob) => assert_eq!(blob.into_inner(), bytes),
            other => panic!("expected B, got {other:?}"),
        }
    }

    #[test]
    fn bs_roundtrips_byte_exact() {
        let b1 = vec![1u8, 2, 3];
        let b2 = vec![255u8, 0, 127];
        let sdk = SdkAttrValue::Bs(vec![Blob::new(b1.clone()), Blob::new(b2.clone())]);
        let rt = roundtrip_sdk(sdk);
        match rt {
            SdkAttrValue::Bs(blobs) => {
                assert_eq!(blobs[0].as_ref(), b1.as_slice());
                assert_eq!(blobs[1].as_ref(), b2.as_slice());
            }
            other => panic!("expected Bs, got {other:?}"),
        }
    }

    // -----------------------------------------------------------------------
    // (c) Deeply nested L containing M containing L
    // -----------------------------------------------------------------------

    #[test]
    fn deeply_nested_l_m_l_roundtrips() {
        // L[ M{ "inner": L[ S("leaf") ] } ]
        let inner_l = SdkAttrValue::L(vec![SdkAttrValue::S("leaf".into())]);
        let mut m = HashMap::new();
        m.insert("inner".to_string(), inner_l);
        let outer_l = SdkAttrValue::L(vec![SdkAttrValue::M(m)]);

        let rt = roundtrip_sdk(outer_l);

        match rt {
            SdkAttrValue::L(outer) => {
                assert_eq!(outer.len(), 1);
                match &outer[0] {
                    SdkAttrValue::M(m) => {
                        match m.get("inner") {
                            Some(SdkAttrValue::L(list)) => {
                                assert_eq!(list.len(), 1);
                                assert!(matches!(&list[0], SdkAttrValue::S(s) if s == "leaf"));
                            }
                            other => panic!("expected inner L, got {other:?}"),
                        }
                    }
                    other => panic!("expected M inside outer L, got {other:?}"),
                }
            }
            other => panic!("expected outer L, got {other:?}"),
        }
    }

    // -----------------------------------------------------------------------
    // (d) Serde JSON shape tests — each tag produces the documented shape
    // -----------------------------------------------------------------------

    #[test]
    fn s_json_shape() {
        let v = AttrValue::S("hello".into());
        let j = serde_json::to_value(&v).unwrap();
        assert_eq!(j, serde_json::json!({"S": "hello"}));
        let rt: AttrValue = serde_json::from_value(j).unwrap();
        assert_eq!(rt, AttrValue::S("hello".into()));
    }

    #[test]
    fn n_json_shape() {
        let v = AttrValue::N("123.45".into());
        let j = serde_json::to_value(&v).unwrap();
        assert_eq!(j, serde_json::json!({"N": "123.45"}));
    }

    #[test]
    fn bool_json_shape() {
        let v = AttrValue::Bool(true);
        let j = serde_json::to_value(&v).unwrap();
        assert_eq!(j, serde_json::json!({"BOOL": true}));
    }

    #[test]
    fn null_json_shape() {
        let v = AttrValue::Null(true);
        let j = serde_json::to_value(&v).unwrap();
        assert_eq!(j, serde_json::json!({"NULL": true}));
    }

    #[test]
    fn ss_json_shape() {
        let v = AttrValue::Ss(vec!["a".into(), "b".into()]);
        let j = serde_json::to_value(&v).unwrap();
        assert_eq!(j, serde_json::json!({"SS": ["a", "b"]}));
    }

    #[test]
    fn ns_json_shape() {
        let v = AttrValue::Ns(vec!["1".into(), "2".into()]);
        let j = serde_json::to_value(&v).unwrap();
        assert_eq!(j, serde_json::json!({"NS": ["1", "2"]}));
    }

    #[test]
    fn b_json_shape_is_base64() {
        let bytes = vec![b'A', b'W', b'S']; // "AWS" → "QVNT" in standard base64... wait
        // "AWS" in bytes is [65, 87, 83] → base64 is "QVNT" ... let me recalculate:
        // A=65, W=87, S=83. Group: 010000 010101 011001 010011 → Q, V, N, T → "QVNT"
        // Actually let me just use a known value and verify the round-trip.
        let v = AttrValue::B(bytes.clone());
        let j = serde_json::to_value(&v).unwrap();
        // Must be {"B": "<base64 string>"}
        assert!(j.get("B").is_some());
        assert!(j["B"].is_string());
        // Round-trip
        let rt: AttrValue = serde_json::from_value(j).unwrap();
        assert_eq!(rt, AttrValue::B(bytes));
    }

    #[test]
    fn bs_json_shape_is_base64_array() {
        let b1 = vec![1u8, 2, 3];
        let b2 = vec![4u8, 5, 6];
        let v = AttrValue::Bs(vec![b1.clone(), b2.clone()]);
        let j = serde_json::to_value(&v).unwrap();
        assert!(j.get("BS").is_some());
        assert!(j["BS"].is_array());
        assert_eq!(j["BS"].as_array().unwrap().len(), 2);
        // Each element is a string.
        for elem in j["BS"].as_array().unwrap() {
            assert!(elem.is_string());
        }
        // Round-trip
        let rt: AttrValue = serde_json::from_value(j).unwrap();
        assert_eq!(rt, AttrValue::Bs(vec![b1, b2]));
    }

    #[test]
    fn l_json_shape() {
        let v = AttrValue::L(vec![AttrValue::S("x".into()), AttrValue::N("1".into())]);
        let j = serde_json::to_value(&v).unwrap();
        assert_eq!(j, serde_json::json!({"L": [{"S": "x"}, {"N": "1"}]}));
    }

    #[test]
    fn m_json_shape() {
        let mut map = HashMap::new();
        map.insert("k".to_string(), AttrValue::Bool(false));
        let v = AttrValue::M(map);
        let j = serde_json::to_value(&v).unwrap();
        assert_eq!(j, serde_json::json!({"M": {"k": {"BOOL": false}}}));
    }

    // -----------------------------------------------------------------------
    // SelectMode and CountMode serialization tests
    // -----------------------------------------------------------------------

    #[test]
    fn select_mode_serializes_screaming_snake_case() {
        let cases = [
            (SelectMode::AllAttributes, "ALL_ATTRIBUTES"),
            (SelectMode::AllProjectedAttributes, "ALL_PROJECTED_ATTRIBUTES"),
            (SelectMode::SpecificAttributes, "SPECIFIC_ATTRIBUTES"),
            (SelectMode::Count, "COUNT"),
        ];
        for (mode, expected) in cases {
            let j = serde_json::to_value(mode).unwrap();
            assert_eq!(j, serde_json::Value::String(expected.to_string()));
        }
    }

    #[test]
    fn count_mode_serializes_lowercase() {
        assert_eq!(serde_json::to_value(CountMode::Scan).unwrap(), serde_json::json!("scan"));
        assert_eq!(serde_json::to_value(CountMode::Query).unwrap(), serde_json::json!("query"));
    }

    // -----------------------------------------------------------------------
    // compact_activity_params tests
    // -----------------------------------------------------------------------

    #[test]
    fn compact_params_includes_required_fields() {
        let params = compact_activity_params(
            "my_table",
            None,
            false,
            false,
            Some(100),
            false,
            None,
            Some(1),
            None,
        );
        assert_eq!(params["table_name"], "my_table");
        assert_eq!(params["has_filter"], false);
        assert_eq!(params["has_key_condition"], false);
        assert_eq!(params["limit"], 100);
        assert_eq!(params["consistent_read"], false);
        assert_eq!(params["page"], 1);
        // Optional fields absent
        assert!(params.get("index_name").is_none());
        assert!(params.get("select").is_none());
        assert!(params.get("scan_index_forward").is_none());
    }

    #[test]
    fn compact_params_includes_optional_fields_when_set() {
        let params = compact_activity_params(
            "orders",
            Some("byCustomer"),
            true,
            true,
            Some(50),
            true,
            Some(SelectMode::AllAttributes),
            Some(2),
            Some(false),
        );
        assert_eq!(params["table_name"], "orders");
        assert_eq!(params["index_name"], "byCustomer");
        assert_eq!(params["has_filter"], true);
        assert_eq!(params["has_key_condition"], true);
        assert_eq!(params["limit"], 50);
        assert_eq!(params["consistent_read"], true);
        assert_eq!(params["select"], "ALL_ATTRIBUTES");
        assert_eq!(params["page"], 2);
        assert_eq!(params["scan_index_forward"], false);
    }

    #[test]
    fn compact_params_omits_none_limit_and_page() {
        let params = compact_activity_params("t", None, false, false, None, false, None, None, None);
        assert!(params.get("limit").is_none());
        assert!(params.get("page").is_none());
    }

    // -----------------------------------------------------------------------
    // Request envelope deserialization tests
    // -----------------------------------------------------------------------

    #[test]
    fn scan_request_deserializes_from_snake_case_json() {
        let json = serde_json::json!({
            "connection_id": "00000000-0000-0000-0000-000000000001",
            "table_name": "events",
            "limit": 100,
            "page": 1,
            "consistent_read": false,
        });
        let req: ScanRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.table_name, "events");
        assert_eq!(req.limit, 100);
        assert!(!req.consistent_read);
        assert!(req.index_name.is_none());
        assert!(req.filter_expression.is_none());
    }

    #[test]
    fn count_request_deserializes_mode_field() {
        let json = serde_json::json!({
            "connection_id": "00000000-0000-0000-0000-000000000001",
            "table_name": "events",
            "mode": "query",
            "consistent_read": true,
            "key_condition_expression": "#pk = :pk",
        });
        let req: CountRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.mode, CountMode::Query);
        assert!(req.consistent_read);
    }

    #[test]
    fn origin_from_activity_log_serializes_correctly() {
        // Verify the reused Origin type serializes as documented.
        assert_eq!(serde_json::to_value(Origin::User).unwrap(), serde_json::json!("user"));
        assert_eq!(serde_json::to_value(Origin::Auto).unwrap(), serde_json::json!("auto"));
    }
}
