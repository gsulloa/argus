import { invoke } from "@tauri-apps/api/core";

export interface ConnectionFormIntent {
  mode: "create" | "edit" | "duplicate";
  kind: string;
  connectionId?: string;
  /** Engine-specific sub-mode (e.g. DynamoDB "credentials-only" re-auth). */
  subMode?: string;
}

/**
 * Open (or focus) the connection-form window with the given intent.
 * Maps to the Rust command `ensure_connection_form_window`.
 */
export function openConnectionFormWindow(intent: ConnectionFormIntent): Promise<void> {
  return invoke("ensure_connection_form_window", { intent });
}
