use aws_sdk_dynamodb::Client as DynamoClient;

use crate::error::{AppError, AppResult};
use crate::modules::dynamo::tables::types::{
    AttributeDefinitionInfo, AttributeType, BillingMode, GsiInfo, KeySchemaElement, KeyType,
    LsiInfo, ProvisionedThroughputInfo, StreamSpecificationInfo, TableDescription, TableStatus,
};

// ---------------------------------------------------------------------------
// Mapper helpers
// ---------------------------------------------------------------------------

fn map_key_schema(
    ks: &[aws_sdk_dynamodb::types::KeySchemaElement],
) -> Vec<KeySchemaElement> {
    ks.iter()
        .map(|e| KeySchemaElement {
            attribute_name: e.attribute_name().to_string(),
            key_type: match e.key_type() {
                aws_sdk_dynamodb::types::KeyType::Hash => KeyType::Hash,
                aws_sdk_dynamodb::types::KeyType::Range => KeyType::Range,
                _ => KeyType::Hash, // forward-compatible fallback
            },
        })
        .collect()
}

fn map_table_status(s: &aws_sdk_dynamodb::types::TableStatus) -> TableStatus {
    match s {
        aws_sdk_dynamodb::types::TableStatus::Active => TableStatus::Active,
        aws_sdk_dynamodb::types::TableStatus::Creating => TableStatus::Creating,
        aws_sdk_dynamodb::types::TableStatus::Updating => TableStatus::Updating,
        aws_sdk_dynamodb::types::TableStatus::Deleting => TableStatus::Deleting,
        aws_sdk_dynamodb::types::TableStatus::InaccessibleEncryptionCredentials => {
            TableStatus::InaccessibleEncryptionCredentials
        }
        aws_sdk_dynamodb::types::TableStatus::Archiving => TableStatus::Archiving,
        aws_sdk_dynamodb::types::TableStatus::Archived => TableStatus::Archived,
        _ => TableStatus::Unknown,
    }
}

fn map_billing_mode(
    summary: Option<&aws_sdk_dynamodb::types::BillingModeSummary>,
) -> BillingMode {
    match summary
        .and_then(|s| s.billing_mode())
        .map(|bm| bm.as_str())
    {
        Some("PAY_PER_REQUEST") => BillingMode::PayPerRequest,
        _ => BillingMode::Provisioned,
    }
}

fn map_attribute_definitions(
    ads: &[aws_sdk_dynamodb::types::AttributeDefinition],
) -> Vec<AttributeDefinitionInfo> {
    ads.iter()
        .map(|ad| AttributeDefinitionInfo {
            attribute_name: ad.attribute_name().to_string(),
            attribute_type: match ad.attribute_type() {
                aws_sdk_dynamodb::types::ScalarAttributeType::S => AttributeType::S,
                aws_sdk_dynamodb::types::ScalarAttributeType::N => AttributeType::N,
                aws_sdk_dynamodb::types::ScalarAttributeType::B => AttributeType::B,
                _ => AttributeType::S, // forward-compatible
            },
        })
        .collect()
}

fn map_gsi(
    gsi: &aws_sdk_dynamodb::types::GlobalSecondaryIndexDescription,
) -> GsiInfo {
    let projection_type = gsi
        .projection()
        .and_then(|p| p.projection_type())
        .map(|pt| pt.as_str().to_string())
        .unwrap_or_else(|| "ALL".to_string());

    let index_status = gsi
        .index_status()
        .map(|s| s.as_str().to_string())
        .unwrap_or_default();

    let provisioned_throughput =
        gsi.provisioned_throughput()
            .and_then(|pt| {
                let rcu = pt.read_capacity_units()?;
                let wcu = pt.write_capacity_units()?;
                if rcu > 0 || wcu > 0 {
                    Some(ProvisionedThroughputInfo {
                        read_capacity_units: rcu,
                        write_capacity_units: wcu,
                    })
                } else {
                    None
                }
            });

    GsiInfo {
        index_name: gsi.index_name().unwrap_or("").to_string(),
        key_schema: map_key_schema(gsi.key_schema()),
        projection_type,
        index_status,
        provisioned_throughput,
    }
}

fn map_lsi(
    lsi: &aws_sdk_dynamodb::types::LocalSecondaryIndexDescription,
) -> LsiInfo {
    let projection_type = lsi
        .projection()
        .and_then(|p| p.projection_type())
        .map(|pt| pt.as_str().to_string())
        .unwrap_or_else(|| "ALL".to_string());

    LsiInfo {
        index_name: lsi.index_name().unwrap_or("").to_string(),
        key_schema: map_key_schema(lsi.key_schema()),
        projection_type,
    }
}

fn map_stream_spec(
    spec: Option<&aws_sdk_dynamodb::types::StreamSpecification>,
) -> Option<StreamSpecificationInfo> {
    match spec {
        Some(s) if s.stream_enabled() => Some(StreamSpecificationInfo {
            stream_enabled: true,
            stream_view_type: s
                .stream_view_type()
                .map(|svt| svt.as_str().to_string()),
        }),
        _ => None,
    }
}

fn map_creation_date_time(
    dt: Option<&aws_sdk_dynamodb::primitives::DateTime>,
) -> Option<String> {
    dt.map(|d| {
        // Format as RFC-3339 / ISO-8601 UTC string.
        let secs = d.secs();
        let nanos = d.subsec_nanos();
        // Use time crate to produce a proper ISO-8601 string.
        let ts = time::OffsetDateTime::from_unix_timestamp(secs)
            .ok()
            .and_then(|t| {
                t.checked_add(time::Duration::nanoseconds(nanos as i64))
            });
        match ts {
            Some(t) => t
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_else(|_| format!("{secs}")),
            None => format!("{secs}"),
        }
    })
}

// ---------------------------------------------------------------------------
// Public mapping function
// ---------------------------------------------------------------------------

/// Map the raw AWS `TableDescription` SDK type into our wire envelope.
pub fn map_table_description(
    raw: aws_sdk_dynamodb::types::TableDescription,
) -> TableDescription {
    let table_name = raw.table_name().unwrap_or("").to_string();
    let table_arn = raw.table_arn().unwrap_or("").to_string();
    let table_status = raw
        .table_status()
        .map(map_table_status)
        .unwrap_or(TableStatus::Unknown);
    let creation_date_time = map_creation_date_time(raw.creation_date_time());
    let item_count = raw.item_count().unwrap_or(0).max(0) as u64;
    let table_size_bytes = raw.table_size_bytes().unwrap_or(0).max(0) as u64;
    let billing_mode = map_billing_mode(raw.billing_mode_summary());
    let key_schema = map_key_schema(raw.key_schema());
    let attribute_definitions = map_attribute_definitions(raw.attribute_definitions());
    let global_secondary_indexes = raw
        .global_secondary_indexes()
        .iter()
        .map(map_gsi)
        .collect();
    let local_secondary_indexes = raw
        .local_secondary_indexes()
        .iter()
        .map(map_lsi)
        .collect();
    let stream_specification = map_stream_spec(raw.stream_specification());

    TableDescription {
        table_name,
        table_arn,
        table_status,
        creation_date_time,
        item_count,
        table_size_bytes,
        billing_mode,
        key_schema,
        attribute_definitions,
        global_secondary_indexes,
        local_secondary_indexes,
        stream_specification,
    }
}

// ---------------------------------------------------------------------------
// Public command: call DescribeTable and map the result
// ---------------------------------------------------------------------------

pub async fn describe_table(
    client: &DynamoClient,
    table_name: &str,
) -> AppResult<TableDescription> {
    use aws_sdk_dynamodb::error::ProvideErrorMetadata;

    let resp = client
        .describe_table()
        .table_name(table_name)
        .send()
        .await
        .map_err(|e| {
            let code = e.meta().code().unwrap_or("Unknown").to_string();
            let message = e
                .meta()
                .message()
                .map(String::from)
                .unwrap_or_else(|| format!("{e:?}"));
            AppError::aws(code, message, false)
        })?;

    let raw = resp
        .table()
        .ok_or_else(|| {
            AppError::aws(
                "InternalServerError",
                "DescribeTable returned no table body",
                false,
            )
        })?
        .clone();

    Ok(map_table_description(raw))
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_dynamodb::types::{
        AttributeDefinition, BillingModeSummary, BillingMode as SdkBillingMode,
        GlobalSecondaryIndexDescription, IndexStatus, KeySchemaElement as SdkKeySchemaElement,
        KeyType as SdkKeyType, Projection, ProjectionType, ProvisionedThroughputDescription,
        ScalarAttributeType, StreamSpecification, StreamViewType,
        TableDescription as SdkTableDescription, TableStatus as SdkTableStatus,
    };

    fn build_key_schema_element(name: &str, kt: SdkKeyType) -> SdkKeySchemaElement {
        SdkKeySchemaElement::builder()
            .attribute_name(name)
            .key_type(kt)
            .build()
            .unwrap()
    }

    fn build_attr_def(name: &str, t: ScalarAttributeType) -> AttributeDefinition {
        AttributeDefinition::builder()
            .attribute_name(name)
            .attribute_type(t)
            .build()
            .unwrap()
    }

    fn build_billing_summary(mode: SdkBillingMode) -> BillingModeSummary {
        BillingModeSummary::builder()
            .billing_mode(mode)
            .build()
    }

    fn build_gsi(name: &str, hash_key: &str) -> GlobalSecondaryIndexDescription {
        GlobalSecondaryIndexDescription::builder()
            .index_name(name)
            .key_schema(build_key_schema_element(hash_key, SdkKeyType::Hash))
            .projection(
                Projection::builder()
                    .projection_type(ProjectionType::All)
                    .build(),
            )
            .index_status(IndexStatus::Active)
            .build()
    }

    fn build_stream_spec(enabled: bool, view_type: Option<StreamViewType>) -> StreamSpecification {
        let mut b = StreamSpecification::builder().stream_enabled(enabled);
        if let Some(vt) = view_type {
            b = b.stream_view_type(vt);
        }
        b.build().unwrap()
    }

    // -----------------------------------------------------------------------
    // Test 1: ACTIVE on-demand table with streams (NEW_AND_OLD_IMAGES) + 1 GSI
    // -----------------------------------------------------------------------
    #[test]
    fn active_on_demand_table_with_streams_and_gsi() {
        let raw = SdkTableDescription::builder()
            .table_name("events")
            .table_arn("arn:aws:dynamodb:us-east-1:123456789012:table/events")
            .table_status(SdkTableStatus::Active)
            .item_count(1000)
            .table_size_bytes(1_048_576)
            .billing_mode_summary(build_billing_summary(SdkBillingMode::PayPerRequest))
            .key_schema(build_key_schema_element("pk", SdkKeyType::Hash))
            .key_schema(build_key_schema_element("sk", SdkKeyType::Range))
            .attribute_definitions(build_attr_def("pk", ScalarAttributeType::S))
            .attribute_definitions(build_attr_def("sk", ScalarAttributeType::S))
            .global_secondary_indexes(build_gsi("byCustomer", "customerId"))
            .stream_specification(build_stream_spec(
                true,
                Some(StreamViewType::NewAndOldImages),
            ))
            .build();

        let desc = map_table_description(raw);

        // Table basics
        assert_eq!(desc.table_name, "events");
        assert_eq!(
            desc.table_arn,
            "arn:aws:dynamodb:us-east-1:123456789012:table/events"
        );
        assert_eq!(desc.table_status, TableStatus::Active);
        assert_eq!(desc.item_count, 1000);
        assert_eq!(desc.table_size_bytes, 1_048_576);
        assert_eq!(desc.billing_mode, BillingMode::PayPerRequest);

        // Key schema: two elements
        assert_eq!(desc.key_schema.len(), 2);
        assert_eq!(desc.key_schema[0].attribute_name, "pk");
        assert_eq!(desc.key_schema[0].key_type, KeyType::Hash);
        assert_eq!(desc.key_schema[1].attribute_name, "sk");
        assert_eq!(desc.key_schema[1].key_type, KeyType::Range);

        // Attribute definitions
        assert_eq!(desc.attribute_definitions.len(), 2);

        // One GSI
        assert_eq!(desc.global_secondary_indexes.len(), 1);
        assert_eq!(desc.global_secondary_indexes[0].index_name, "byCustomer");
        assert_eq!(desc.global_secondary_indexes[0].projection_type, "ALL");
        assert_eq!(desc.global_secondary_indexes[0].index_status, "ACTIVE");

        // Streams
        let stream = desc.stream_specification.as_ref().unwrap();
        assert!(stream.stream_enabled);
        assert_eq!(
            stream.stream_view_type.as_deref(),
            Some("NEW_AND_OLD_IMAGES")
        );

        // JSON shape verification
        let v = serde_json::to_value(&desc).unwrap();
        assert_eq!(v["billing_mode"], "PAY_PER_REQUEST");
        assert_eq!(v["table_status"], "ACTIVE");
        assert_eq!(v["global_secondary_indexes"][0]["index_name"], "byCustomer");
        assert_eq!(
            v["stream_specification"]["stream_view_type"],
            "NEW_AND_OLD_IMAGES"
        );
    }

    // -----------------------------------------------------------------------
    // Test 2: stream_enabled = false → stream_specification is None
    // -----------------------------------------------------------------------
    #[test]
    fn stream_disabled_maps_to_none() {
        let raw = SdkTableDescription::builder()
            .table_name("orders")
            .table_arn("arn:aws:dynamodb:us-east-1:111111111111:table/orders")
            .table_status(SdkTableStatus::Active)
            .item_count(0)
            .table_size_bytes(0)
            .billing_mode_summary(build_billing_summary(SdkBillingMode::Provisioned))
            .key_schema(build_key_schema_element("id", SdkKeyType::Hash))
            .attribute_definitions(build_attr_def("id", ScalarAttributeType::S))
            .stream_specification(build_stream_spec(false, None))
            .build();

        let desc = map_table_description(raw);
        assert!(desc.stream_specification.is_none());

        // Also check the JSON: stream_specification should not appear.
        let v = serde_json::to_value(&desc).unwrap();
        assert!(v.get("stream_specification").is_none());
    }

    // -----------------------------------------------------------------------
    // Test 3: No stream_specification field at all → None
    // -----------------------------------------------------------------------
    #[test]
    fn no_stream_spec_maps_to_none() {
        let raw = SdkTableDescription::builder()
            .table_name("users")
            .table_arn("arn:aws:dynamodb:us-east-1:111111111111:table/users")
            .table_status(SdkTableStatus::Active)
            .item_count(0)
            .table_size_bytes(0)
            .billing_mode_summary(build_billing_summary(SdkBillingMode::Provisioned))
            .key_schema(build_key_schema_element("id", SdkKeyType::Hash))
            .attribute_definitions(build_attr_def("id", ScalarAttributeType::S))
            // no .stream_specification(...)
            .build();

        let desc = map_table_description(raw);
        assert!(desc.stream_specification.is_none());
    }

    // -----------------------------------------------------------------------
    // Test 4: Provisioned table with non-zero throughput includes provisioned_throughput on GSI
    // -----------------------------------------------------------------------
    #[test]
    fn provisioned_gsi_includes_throughput() {
        let pt = ProvisionedThroughputDescription::builder()
            .read_capacity_units(5)
            .write_capacity_units(5)
            .build();
        let gsi = GlobalSecondaryIndexDescription::builder()
            .index_name("idx")
            .key_schema(build_key_schema_element("pk", SdkKeyType::Hash))
            .projection(
                Projection::builder()
                    .projection_type(ProjectionType::All)
                    .build(),
            )
            .index_status(IndexStatus::Active)
            .provisioned_throughput(pt)
            .build();

        let raw = SdkTableDescription::builder()
            .table_name("products")
            .table_arn("arn:aws:dynamodb:us-east-1:111111111111:table/products")
            .table_status(SdkTableStatus::Active)
            .item_count(0)
            .table_size_bytes(0)
            .key_schema(build_key_schema_element("pk", SdkKeyType::Hash))
            .attribute_definitions(build_attr_def("pk", ScalarAttributeType::S))
            .global_secondary_indexes(gsi)
            .build();

        let desc = map_table_description(raw);
        let gsi_out = &desc.global_secondary_indexes[0];
        assert!(gsi_out.provisioned_throughput.is_some());
        let pt_out = gsi_out.provisioned_throughput.as_ref().unwrap();
        assert_eq!(pt_out.read_capacity_units, 5);
        assert_eq!(pt_out.write_capacity_units, 5);
    }
}
