export type ConnectionParams = Record<string, unknown>;

export interface Connection {
  id: string;
  name: string;
  kind: string;
  params: ConnectionParams;
  created_at: number;
  updated_at: number;
}

export interface ConnectionInput {
  name: string;
  kind: string;
  params: ConnectionParams;
  secret?: string | null;
}

export interface ConnectionUpdate {
  name?: string;
  params?: ConnectionParams;
  /** `null` clears the keychain entry; omit to leave it untouched. */
  secret?: string | null;
}
