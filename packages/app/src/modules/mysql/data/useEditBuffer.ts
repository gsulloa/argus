/**
 * MySQL edit buffer — mirrors Postgres useEditBuffer.ts 1:1.
 * The Postgres version already uses generic `EditValue` / `EditOp` types that
 * match the MySQL shapes, so we re-export it here with MySQL-typed imports.
 *
 * Re-exports the implementation from the Postgres module because the buffer
 * logic is driver-agnostic (it only tracks JS values and row keys).
 * The MySQL TableViewerTab imports from this file to keep the module boundary clean.
 */

// The edit buffer implementation in Postgres is completely driver-agnostic —
// it only tracks JS values, row keys, and undo stacks. We re-export it directly.
export {
  useEditBuffer,
  buildRowKey,
  buildRefreshedRowMap,
  type RowKey,
  type RowEdits,
  type RowEditKind,
  type UseEditBufferResult,
} from "@/modules/postgres/data/useEditBuffer";
