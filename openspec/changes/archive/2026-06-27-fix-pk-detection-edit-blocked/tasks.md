## 1. Reproduce and confirm root cause

- [x] 1.1 Reproduce #195: open a Postgres table that TablePlus edits but Argus shows "No primary key". Capture which path triggers it — fetch error, enum-lookup failure, or a genuine detection gap (note the schema, table, and PK shape).
- [x] 1.2 Confirm whether the same table reproduces on MySQL/MSSQL connections (parity check). Record findings in the change folder before coding.

## 2. Postgres backend — decouple enum lookup from PK detection

- [x] 2.1 In `packages/app/src-tauri/src/modules/postgres/edit.rs` `postgres_table_primary_key()`, run the enum lookup so its failure does not propagate via `?`; on enum error return the resolved `pk_columns` with `enums: {}` instead of erroring the whole command.
- [x] 2.2 Keep the PK-lookup failure (and timeout) a hard `AppError`; do not convert a failed PK lookup into `pk_columns: null`.
- [x] 2.3 Add a Rust unit test asserting that an enum-lookup failure still returns the resolved PK with empty enums.

## 3. Postgres frontend — distinguish error from no-PK

- [x] 3.1 In `packages/app/src/modules/postgres/data/TableViewerTab.tsx`, stop coercing the lookup `error` status into `pkColumns = null`; gate `noPkBanner` on `pkLookup.status === "ready" && pkColumns === null` (not on the error state).
- [x] 3.2 Add an error-state banner (with the underlying `error.message`) and a Retry button that calls the existing `useTablePrimaryKey().refresh()`; wire it through `BottomBar.tsx` alongside the existing read-only / no-PK banners.
- [x] 3.3 Ensure `UPDATE`/`DELETE` affordances stay disabled while in the error state, and become enabled after a successful Retry.
- [x] 3.4 Update/extend `TableViewerTab.test.tsx`: a rejected `tablePrimaryKey` shows the retry banner (not "No primary key"); Retry re-invokes the command and restores editing; the genuine `pk_columns: null` case still shows the no-PK banner.

## 4. MySQL frontend — parity

- [x] 4.1 In `packages/app/src/modules/mysql/data/TableViewerTab.tsx`, replace the `.catch(() => setPkResult(null))` swallow with explicit error state (keep the error/AppError); add a `pkError` distinct from `pkResult === null`.
- [x] 4.2 Gate the `pkColumns === null` no-PK banner on a settled-success state; render a separate error banner + Retry (re-runs the PK fetch) when the lookup failed.
- [x] 4.3 Add tests mirroring 3.4 for the MySQL viewer.

## 5. MSSQL frontend — parity

- [x] 5.1 In `packages/app/src/modules/mssql/data/TableViewerTab.tsx`, apply the same error-vs-null distinction and Retry banner as MySQL.
- [x] 5.2 Add tests mirroring 3.4 for the MSSQL viewer (`mssql/data/__tests__/TableViewerTab.test.tsx`).

## 6. Verify and document

- [x] 6.1 Run the full frontend test suite and `cargo test` for the postgres module; confirm green.
- [x] 6.2 Manually verify against the reproduction from task 1: the previously-misreported table is now editable (or, if a genuine detection gap was found, that the error banner names the real cause and a follow-up is filed).
- [x] 6.3 Confirm banner styling matches `DESIGN.md` (no decorative styling; muted/error tokens only) across all three engines.
