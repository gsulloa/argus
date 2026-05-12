/**
 * TypeScript mirrors of the Rust wire types in
 * `src-tauri/src/modules/dynamo/items.rs`.
 *
 * IPC payload types use snake_case to match serde wire format exactly.
 * Internal builder/state types (BuilderState, TypedValue, FilterRow) use
 * camelCase per standard TS convention.
 */

// ---------------------------------------------------------------------------
// §5.1  AttributeValue — discriminated union mirroring AttrValue
// ---------------------------------------------------------------------------

export type AttributeValue =
  | { S: string }
  | { N: string }
  | { BOOL: boolean }
  | { NULL: true }
  | { L: AttributeValue[] }
  | { M: Record<string, AttributeValue> }
  | { SS: string[] }
  | { NS: string[] }
  | { BS: string[] }
  | { B: string };

export type AttributeMap = Record<string, AttributeValue>;

// ---------------------------------------------------------------------------
// §5.2  Enums — wire-exact string literals
// ---------------------------------------------------------------------------

export type SelectMode =
  | "ALL_ATTRIBUTES"
  | "ALL_PROJECTED_ATTRIBUTES"
  | "SPECIFIC_ATTRIBUTES"
  | "COUNT";

export type CountMode = "scan" | "query";

export type Origin = "user" | "auto";

// ---------------------------------------------------------------------------
// §5.2  IPC request/response envelopes — snake_case, verbatim wire shape
// ---------------------------------------------------------------------------

export interface ScanRequest {
  connection_id: string;
  table_name: string;
  index_name: string | null;
  limit: number;
  page: number;
  exclusive_start_key: AttributeMap | null;
  filter_expression: string | null;
  expression_attribute_names: Record<string, string> | null;
  expression_attribute_values: AttributeMap | null;
  projection_expression: string | null;
  consistent_read: boolean;
  select: SelectMode | null;
  origin: Origin | null;
}

export interface QueryRequest {
  connection_id: string;
  table_name: string;
  index_name: string | null;
  limit: number;
  page: number;
  exclusive_start_key: AttributeMap | null;
  key_condition_expression: string;
  filter_expression: string | null;
  expression_attribute_names: Record<string, string> | null;
  expression_attribute_values: AttributeMap | null;
  projection_expression: string | null;
  consistent_read: boolean;
  select: SelectMode | null;
  scan_index_forward: boolean | null;
  origin: Origin | null;
}

export interface CountRequest {
  connection_id: string;
  table_name: string;
  mode: CountMode;
  index_name: string | null;
  key_condition_expression: string | null;
  filter_expression: string | null;
  expression_attribute_names: Record<string, string> | null;
  expression_attribute_values: AttributeMap | null;
  scan_index_forward: boolean | null;
  consistent_read: boolean;
  origin: Origin | null;
}

export interface ScanResponse {
  items: AttributeMap[];
  last_evaluated_key: AttributeMap | null;
  scanned_count: number;
  count: number;
  consumed_capacity: unknown | null;
}

export interface QueryResponse {
  items: AttributeMap[];
  last_evaluated_key: AttributeMap | null;
  scanned_count: number;
  count: number;
  consumed_capacity: unknown | null;
}

export interface CountResponse {
  total_count: number;
  total_scanned_count: number;
  page_count: number;
  consumed_capacity: unknown | null;
}

// ---------------------------------------------------------------------------
// §5.2  Internal builder types — camelCase (TS-side state, not IPC)
// ---------------------------------------------------------------------------

export type TypedValue =
  | { type: "S"; value: string }
  | { type: "N"; value: string }
  | { type: "BOOL"; value: boolean }
  | { type: "NULL" };

export type FilterRow =
  | {
      kind: "compare";
      attribute: string;
      op:
        | "="
        | "<>"
        | "<"
        | "<="
        | ">"
        | ">="
        | "contains"
        | "begins_with"
        | "between";
      value: TypedValue | { min: TypedValue; max: TypedValue };
    }
  | {
      kind: "unary";
      attribute: string;
      op:
        | "attribute_exists"
        | "attribute_not_exists"
        | "is_null"
        | "is_not_null";
    }
  | {
      kind: "attribute_type";
      attribute: string;
      type: "S" | "N" | "B" | "BOOL" | "NULL" | "L" | "M" | "SS" | "NS" | "BS";
    };

export interface BuilderState {
  mode: "scan" | "query";
  indexName: string | null;
  pageSize: number;
  consistentRead: boolean;
  scanIndexForward: boolean;
  query?: {
    partitionKey: { name: string; value: TypedValue };
    sortKey?: {
      name: string;
      op: "=" | "<" | "<=" | ">" | ">=" | "between" | "begins_with";
      value: TypedValue | { min: TypedValue; max: TypedValue };
    };
  };
  filters: FilterRow[];
}
