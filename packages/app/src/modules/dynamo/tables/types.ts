/**
 * TypeScript mirrors of the Rust wire types in
 * `src-tauri/src/modules/dynamo/tables/types.rs`.
 *
 * All keys are snake_case to match the serde wire format exactly.
 * Do NOT camelCase these — the IPC layer transmits them verbatim.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export type BillingMode = "PAY_PER_REQUEST" | "PROVISIONED";

export type TableStatus =
  | "ACTIVE"
  | "CREATING"
  | "UPDATING"
  | "DELETING"
  | "INACCESSIBLE_ENCRYPTION_CREDENTIALS"
  | "ARCHIVING"
  | "ARCHIVED"
  | "UNKNOWN";

export type KeyType = "HASH" | "RANGE";

export type AttributeType = "S" | "N" | "B";

// ---------------------------------------------------------------------------
// Key + attribute sub-types
// ---------------------------------------------------------------------------

export interface KeySchemaElement {
  attribute_name: string;
  key_type: KeyType;
}

export interface AttributeDefinitionInfo {
  attribute_name: string;
  attribute_type: AttributeType;
}

// ---------------------------------------------------------------------------
// Provisioned throughput info (used inside GSI)
// ---------------------------------------------------------------------------

export interface ProvisionedThroughputInfo {
  read_capacity_units: number;
  write_capacity_units: number;
}

// ---------------------------------------------------------------------------
// Index types
// ---------------------------------------------------------------------------

export interface GsiInfo {
  index_name: string;
  key_schema: KeySchemaElement[];
  projection_type: string;
  index_status: string;
  /** Omitted from wire when billing is on-demand. */
  provisioned_throughput?: ProvisionedThroughputInfo;
}

export interface LsiInfo {
  index_name: string;
  key_schema: KeySchemaElement[];
  projection_type: string;
}

// ---------------------------------------------------------------------------
// Stream specification
// ---------------------------------------------------------------------------

export interface StreamSpecificationInfo {
  stream_enabled: boolean;
  /** Omitted from wire when stream_view_type is not applicable. */
  stream_view_type?: string;
}

// ---------------------------------------------------------------------------
// Top-level table description envelope
// ---------------------------------------------------------------------------

export interface TableDescription {
  table_name: string;
  table_arn: string;
  table_status: TableStatus;
  /** Omitted from wire when not available. */
  creation_date_time?: string;
  item_count: number;
  table_size_bytes: number;
  billing_mode: BillingMode;
  key_schema: KeySchemaElement[];
  attribute_definitions: AttributeDefinitionInfo[];
  global_secondary_indexes: GsiInfo[];
  local_secondary_indexes: LsiInfo[];
  /** Omitted from wire when there is no stream / streams disabled. */
  stream_specification?: StreamSpecificationInfo;
}

// ---------------------------------------------------------------------------
// listTables result envelope
// ---------------------------------------------------------------------------

export interface ListTablesResult {
  tables: string[];
  /** Omitted from wire when truncated is false. */
  next_token?: string;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Origin — mirrors the activity-log Origin enum on the Rust side
// ---------------------------------------------------------------------------

export type Origin = "auto" | "user";
