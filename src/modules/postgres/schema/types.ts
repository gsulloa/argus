export interface SchemaSummary {
  name: string;
  owner: string | null;
  is_system: boolean;
  comment: string | null;
}

export type TableKind = "regular" | "partitioned" | "foreign";

export interface TableInfo {
  name: string;
  owner: string | null;
  estimated_rows: number | null;
  comment: string | null;
  kind: TableKind;
}

export interface ViewInfo {
  name: string;
  owner: string | null;
  comment: string | null;
}

export interface FunctionInfo {
  name: string;
  args_signature: string;
  return_type: string | null;
  language: string;
  comment: string | null;
}

export type TypeKind = "composite" | "enum" | "domain" | "range";

export interface TypeInfo {
  name: string;
  kind: TypeKind;
  comment: string | null;
}

export interface ExtensionInfo {
  name: string;
  version: string;
  comment: string | null;
}

export interface IndexInfo {
  name: string;
  table: string;
  is_unique: boolean;
  is_primary: boolean;
  method: string;
}

export type TriggerTiming = "before" | "after" | "instead_of";
export type TriggerEvent = "insert" | "update" | "delete" | "truncate";

export interface TriggerInfo {
  name: string;
  table: string;
  timing: TriggerTiming;
  events: TriggerEvent[];
  function: string;
}

export interface SchemaObjects {
  schema: string;
  tables: TableInfo[];
  views: ViewInfo[];
  materialized_views: ViewInfo[];
  functions: FunctionInfo[];
  types: TypeInfo[];
  extensions: ExtensionInfo[];
  indexes: IndexInfo[];
  triggers: TriggerInfo[];
}

/** Discriminator for tab payloads and search labels. */
export type ObjectKind =
  | "table"
  | "view"
  | "materialized_view"
  | "function"
  | "type"
  | "extension"
  | "index"
  | "trigger";
