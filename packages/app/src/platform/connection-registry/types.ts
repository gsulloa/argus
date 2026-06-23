export type ConnectionParams = Record<string, unknown>;

export interface Connection {
  id: string;
  name: string;
  kind: string;
  params: ConnectionParams;
  group_id: string | null;
  sort_order: number;
  context_path: string | null;
  /** Local, per-connection path to the app source repo read by the AI model
   * inspector. Never stored in the shared context.yaml. */
  project_source_path: string | null;
  /** User-chosen palette color key for this connection, or null if unset. */
  color: string | null;
  created_at: number;
  updated_at: number;
}

export interface ConnectionInput {
  name: string;
  kind: string;
  params: ConnectionParams;
  group_id?: string | null;
  secret?: string | null;
  context_path?: string | null;
  project_source_path?: string | null;
  /** Omit to leave unchanged. `null` clears. */
  color?: string | null;
}

export interface ConnectionUpdate {
  name?: string;
  params?: ConnectionParams;
  /** `null` clears the keychain entry; omit to leave it untouched. */
  secret?: string | null;
  /** Omit to leave unchanged. `null` clears. */
  context_path?: string | null;
  /** Omit to leave unchanged. `null` clears. */
  project_source_path?: string | null;
  /** Omit to leave unchanged. `null` clears. */
  color?: string | null;
}

export interface ConnectionMove {
  group_id: string | null;
  sort_order: number;
}

export interface ConnectionGroup {
  id: string;
  name: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface ConnectionGroupInput {
  name: string;
}

export interface ConnectionGroupUpdate {
  name?: string;
  sort_order?: number;
}
