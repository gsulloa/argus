// ---------------------------------------------------------------------------
// Raw types — mirror Rust serde shapes exactly (snake_case)
// ---------------------------------------------------------------------------

export interface ContextManifest {
  schema_version: number;
  name: string;
  // Forward-compat extras silently preserved over IPC; UI doesn't need them.
  [extra: string]: unknown;
}

export interface ObjectColumn {
  name: string;
  type: string;
  [extra: string]: unknown;
}

export interface ObjectSystem {
  kind: string;
  schema: string | null;
  name: string;
  primary_key: string[] | null;
  columns: ObjectColumn[] | null;
  last_synced: string | null; // ISO 8601 from chrono::DateTime<Utc>
  deleted_in_db: boolean | null;
  [extra: string]: unknown;
}

export interface ObjectHuman {
  tags: string[] | null;
  owners: string[] | null;
  column_notes: Record<string, string> | null;
  [extra: string]: unknown;
}

/** Returned by `context_get_object` — includes the rendered body. */
export interface ObjectDoc {
  system: ObjectSystem;
  human: ObjectHuman;
  body: string;
}

/** Returned by `context_list_objects` — summary only, no body. */
export interface ObjectListItem {
  identity: string; // "schema.name" or "name"
  kind: string;
  name: string;
  schema: string | null;
  has_human: boolean;
  deleted_in_db: boolean;
}

export interface QueryParam {
  name: string;
  type: string | null;
  default: unknown | null; // string | number | boolean | null per yaml
}

export interface QueryListItem {
  name: string;
  description: string | null;
  params: QueryParam[];
  tags: string[];
}

/** Returned by `context_get_query` — includes the body. */
export interface QueryDoc {
  name: string;
  description: string | null;
  params: QueryParam[];
  tags: string[];
  body: string;
}

export interface OrphanedNote {
  file: string;
  key: string;
}

export interface UpdatedObject {
  path: string;
  changes: string[];
}

export interface SyncReport {
  created: string[];
  updated: UpdatedObject[];
  marked_deleted: string[];
  orphaned_notes: OrphanedNote[];
  unchanged: number;
}

export interface AiObjectEntry {
  name: string;
  system: ObjectSystem;
  human: ObjectHuman;
  body_summary: string | null;
  body: string | null;
}

export interface AiQueryEntry {
  name: string;
  description: string | null;
  body: string;
}

export interface AiPayload {
  manifest: ContextManifest | null;
  overview: string | null;
  glossary: string | null;
  objects: AiObjectEntry[];
  queries: AiQueryEntry[];
}

// ---------------------------------------------------------------------------
// Event payload (emitted by the Rust ContextRegistry watcher)
// ---------------------------------------------------------------------------

export type ContextChangeKind = "manifest" | "object" | "query";

export interface ContextChangedEvent {
  /** Canonical path of the folder that changed (string). */
  path: string;
  /** Categories of files that changed in this debounce window. */
  kinds: ContextChangeKind[];
}

export const CONTEXT_CHANGED_EVENT = "context://changed";

// ---------------------------------------------------------------------------
// Known-folder discovery (context_list_known_folders)
// ---------------------------------------------------------------------------

/** One entry from `context_list_known_folders` — mirrors the Rust result type. */
export interface KnownFolder {
  /** Canonical path of the context folder root. */
  path: string;
  /** Display name from `context.yaml`. */
  name: string;
  /** IDs of connections already pointing at this root. */
  connection_ids: string[];
}
