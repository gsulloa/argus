/**
 * Invoke wrappers for `dynamo_run_partiql` and `dynamo_run_partiql_many`.
 *
 * Wire shapes mirror the Rust envelopes exactly (snake_case).
 * `AttributeMap` / `AttributeValue` are reused from data-view/types so
 * downstream rendering can be shared verbatim.
 */

import { invoke } from "@tauri-apps/api/core";
import { toAppError } from "@/platform/errors/AppError";
import type { AttributeMap } from "../data-view/types";

// ---------------------------------------------------------------------------
// Result types (mirrors Rust RunPartiQLResult enum)
// ---------------------------------------------------------------------------

export type StatementType = "INSERT" | "UPDATE" | "DELETE";
export type Origin = "user" | "auto";

export interface PartiQLRowsResult {
  kind: "rows";
  items: AttributeMap[];
  count: number;
  query_ms: number;
  truncated: boolean;
  consumed_capacity: unknown | null;
}

export interface PartiQLSucceededResult {
  kind: "succeeded";
  statement_type: StatementType;
  query_ms: number;
  consumed_capacity: unknown | null;
}

export type RunPartiQLResult = PartiQLRowsResult | PartiQLSucceededResult;

// ---------------------------------------------------------------------------
// Multi-statement result types (mirrors Rust dynamo_run_partiql_many)
// ---------------------------------------------------------------------------

export interface PartiQLOutcomeOk {
  index: number;
  statement: string;
  outcome: "ok";
  result: RunPartiQLResult;
}

export interface PartiQLOutcomeErr {
  index: number;
  statement: string;
  outcome: "err";
  error: { message: string };
}

export interface PartiQLOutcomeSkipped {
  index: number;
  statement: string;
  outcome: "skipped";
}

export type PartiQLStatementOutcome =
  | PartiQLOutcomeOk
  | PartiQLOutcomeErr
  | PartiQLOutcomeSkipped;

export interface RunPartiQLManyResult {
  outcomes: PartiQLStatementOutcome[];
}

// ---------------------------------------------------------------------------
// Invoke helpers
// ---------------------------------------------------------------------------

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toAppError(e);
  }
}

/**
 * Run a single PartiQL statement.
 * Wire arg: `{ req: { connection_id, statement, origin } }` — snake_case
 * to match the Rust serde derive, same convention as `dynamo_scan`.
 */
export function dynamoRunPartiql(
  connectionId: string,
  statement: string,
  origin: Origin = "user",
): Promise<RunPartiQLResult> {
  return call<RunPartiQLResult>("dynamo_run_partiql", {
    req: { connection_id: connectionId, statement, origin },
  });
}

/**
 * Run multiple PartiQL statements sequentially.
 * Wire arg: `{ req: { connection_id, statements, origin } }`.
 */
export function dynamoRunPartiqlMany(
  connectionId: string,
  statements: string[],
  origin: Origin = "user",
): Promise<RunPartiQLManyResult> {
  return call<RunPartiQLManyResult>("dynamo_run_partiql_many", {
    req: { connection_id: connectionId, statements, origin },
  });
}
