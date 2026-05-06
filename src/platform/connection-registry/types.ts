export type ConnectionParams = Record<string, unknown>;

export interface Connection {
  id: string;
  name: string;
  kind: string;
  params: ConnectionParams;
  group_id: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface ConnectionInput {
  name: string;
  kind: string;
  params: ConnectionParams;
  group_id?: string | null;
  secret?: string | null;
}

export interface ConnectionUpdate {
  name?: string;
  params?: ConnectionParams;
  /** `null` clears the keychain entry; omit to leave it untouched. */
  secret?: string | null;
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
