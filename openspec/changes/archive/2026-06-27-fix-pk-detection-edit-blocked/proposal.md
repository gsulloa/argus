## Why

Users report tables that are clearly editable in TablePlus showing the banner *"No primary key — existing rows are not editable"* in Argus, blocking all cell edits and row deletes ([#195](https://github.com/gsulloa/argus/issues/195)). The root cause is that the frontend PK-metadata lookup **conflates a failed/errored fetch with a genuine absence of a primary key**: in all three SQL engines the `.catch()` handler sets `pkColumns` to `null`, which is the same sentinel used for "this relation has no PK". Any transient error (timeout, the Postgres enum sub-query failing, a dropped connection) silently degrades a fully-editable table into a read-only one with a misleading message. Editing and deleting existing rows already work — they are gated entirely on this PK metadata — so a flaky lookup is the root blocker behind several "no logro editar / eliminar" reports.

## What Changes

- **Distinguish "lookup failed" from "no PK"** in the data viewer for Postgres, MySQL/MariaDB, and MSSQL. An errored PK-metadata fetch MUST NOT be coerced to `null` (= no PK).
- When the lookup **fails**, show an error banner that names the real cause and offers a **Retry** action, instead of the misleading "No primary key" banner. Edit affordances stay disabled (we genuinely don't know the PK) but the user understands it is a transient failure, not an unsupported table.
- When the lookup **succeeds and the relation truly has no PK**, keep the existing "No primary key — existing rows are not editable" banner unchanged.
- **Postgres backend hardening**: decouple the enum sub-query from PK detection so a failure in the enum lookup can no longer discard a successfully-fetched PK. The command surfaces the PK even when enum metadata is unavailable.
- Apply the same error-vs-null distinction consistently across Postgres, MySQL, and MSSQL viewer tabs (parity).

## Capabilities

### New Capabilities
<!-- None — this is a bug fix to existing edit capabilities. -->

### Modified Capabilities
- `postgres-data-edit`: the PK-metadata command must not let enum-lookup failure null out a valid PK; the viewer must distinguish a failed lookup (retryable error banner) from a relation with no PK (existing banner).
- `mysql-data-edit`: the viewer must distinguish a failed PK lookup (retryable error banner) from a relation with no PK (existing banner) rather than coercing errors to "no PK".
- `mssql-data-edit`: the viewer must distinguish a failed PK lookup (retryable error banner) from a relation with no PK (existing banner) rather than coercing errors to "no PK".

## Impact

- **Frontend (Postgres)**: `useTablePrimaryKey.ts` (already tracks an `error` status — currently ignored by the caller), `TableViewerTab.tsx` (`noPkBanner` gating, new error banner + retry), `BottomBar.tsx` (banner rendering).
- **Frontend (MySQL)**: `mysql/data/TableViewerTab.tsx` — the `.catch(() => setPkResult(null))` handler and the `pkColumns === null` banner.
- **Frontend (MSSQL)**: `mssql/data/TableViewerTab.tsx` — same pattern.
- **Backend (Postgres)**: `postgres/edit.rs` `postgres_table_primary_key()` — make the enum lookup non-fatal to PK detection.
- **No schema/API signature changes**: `pk_columns: string[] | null` stays; the fix is in how the frontend interprets the *error* path vs. the *null* result. Existing tests for the no-PK banner and PK detection continue to hold; new tests cover the error path.
