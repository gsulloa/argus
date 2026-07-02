## Why

Postgres columns of certain types render in the data grid and SQL editor results as literal placeholder strings — `<interval>`, `<oid>`, `<inet>`, `<xid>` — instead of the actual cell value. Users cannot read data they can clearly see exists in the database, which defeats the purpose of an inspection tool. The MySQL and MSSQL adapters already degrade gracefully to a string representation; only Postgres shows these placeholders.

## What Changes

- Fix the Postgres value serializer (`cell_to_json` in `modules/postgres/sql.rs`) so that types which currently fall through to the `<typename>` placeholder instead render their real value.
- Add explicit handling for the commonly-seen affected types:
  - `interval` → human-readable duration string (e.g. `7 days 03:00:00`).
  - `oid` → its numeric value.
  - `xid` / `xid8` → its numeric value.
  - `inet` / `cidr` → the address string (e.g. `192.168.0.1/32`).
  - `macaddr` / `macaddr8` → the MAC string.
- Improve the generic fallback so any remaining unhandled type is decoded to its Postgres textual representation whenever possible, and the `<typename>` envelope becomes a true last resort (only when even textual decoding fails).
- No frontend changes required — the grid and editor already render whatever string/number the backend returns.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `postgres-data-grid`: The value-serialization contract on the `postgres_query_table` command is tightened — values whose type has a readable scalar or textual representation (including `interval`, `oid`, `xid`, `inet`, `cidr`, `macaddr`) MUST be returned as that value, not as a `<typename>` placeholder. The `<typename>` envelope is retained only as a genuine last resort. This behavior is shared by the SQL editor (`postgres-sql-editor` references the same `Value` envelope handling), so both surfaces are fixed by this single backend change.

## Impact

- **Code**: `packages/app/src-tauri/src/modules/postgres/sql.rs` (the `cell_to_json` function). Possibly one added Cargo dependency and/or a `tokio-postgres` feature flag for `interval` decoding.
- **Dependencies**: May add a small crate (e.g. `pg_interval`) and/or enable `tokio-postgres` network-type support, depending on the decode approach chosen in `design.md`.
- **Surfaces**: Postgres data grid and Postgres SQL editor result tables (both consume the same serializer). MySQL/MSSQL adapters are unaffected — they already handle unknown types by string coercion.
- **No breaking changes**: purely a rendering correctness improvement; the response payload shape is unchanged.
