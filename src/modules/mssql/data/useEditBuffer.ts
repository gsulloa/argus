/**
 * MSSQL edit buffer — mirrors MySQL useEditBuffer.ts 1:1.
 * The buffer logic is driver-agnostic (it only tracks JS values and row keys).
 * Re-exports the implementation from the Postgres module for DRY reuse.
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
