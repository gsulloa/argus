## Why

In the Postgres SQL editor every `numeric` / `decimal` cell renders as the literal
string `<numeric>` instead of its value ([#291](https://github.com/gsulloa/argus/issues/291)).
`cell_to_json` (`packages/app/src-tauri/src/modules/postgres/sql.rs:509`) has no
`NUMERIC` arm, the generic `String` fallback rejects the OID, and the last-resort
branch emits `format!("<{}>", pg_type.name())`. The same dead end swallows `money`,
every array type (`<_int4>`, `<_text>`), `timetz`, `bit`/`varbit`, ranges, domains
and the geometric types.

The table browser is unaffected because it builds its `SELECT` with explicit
`::text` casts (`data.rs` `text_castable` already lists `numeric`/`decimal`/`money`),
so Postgres stringifies before Rust ever sees the value. Only the SQL editor runs
user SQL verbatim and must decode the raw **binary** wire format. That asymmetry —
grid fine, SQL editor broken — is exactly what the report describes. Money and
high-precision columns are the most commonly hit, and a placeholder is never a
useful cell value.

## What Changes

- Add an exact `NUMERIC` decoder: a hand-rolled `FromSql` impl over the Postgres
  binary numeric wire format that produces the **exact decimal string** (no `f64`
  round-trip — `numeric` is arbitrary-precision, and silently corrupting monetary
  values is worse than the current placeholder). `NaN`, `Infinity` and `-Infinity`
  are preserved as their Postgres text spellings.
- Add decoders for the other types that currently fall through to the placeholder:
  `MONEY`, `TIMETZ`, `BIT`/`VARBIT`, and the geometric family
  (`POINT`, `LINE`, `LSEG`, `BOX`, `PATH`, `POLYGON`, `CIRCLE`).
- Generalise the fallback instead of only adding special cases: introduce a
  raw-bytes escape hatch (`FromSql` that accepts every type and hands back the
  wire bytes) plus a recursive `decode_raw(ty, bytes)` dispatcher, so
  **arrays** (`Kind::Array`), **ranges** (`Kind::Range`) and **domains**
  (`Kind::Domain`) decode by recursing into their element/base type and reuse
  every scalar decoder above. Arrays become JSON arrays; ranges and domains
  render through their base type.
- Replace the `<type>` last-resort branch. Values that are still undecodable fall
  back to (1) a UTF-8 read of the raw bytes when they are valid UTF-8, then
  (2) the existing hex `binary_envelope` used for `BYTEA` — an honest, copyable
  representation. The `<type>` string is removed entirely.
- Keep the existing fast paths untouched: `BOOL`, `INT2/4/8`, `FLOAT4/8`,
  `JSON/JSONB`, `BYTEA`, the date/time family, `UUID`, `OID`, `XID`, `XID8`,
  `INTERVAL`, `INET/CIDR`, `MACADDR` and the `String` path all keep their current
  return shapes, including truncation envelopes and `truncated_columns` tracking.

Not breaking: `numeric` arrives as a JSON **string**, which is what the table
browser already returns for the same column (via `::text`), and what
`sortResultRows`/`compareCellValues` already handle (`toNumber` parses
numeric-looking strings). No frontend change is required.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `postgres-sql-editor`: adds a **Cell value decoding** requirement pinning the
  JSON shape returned per Postgres type for `kind: "rows"` results — exact-string
  `numeric`, the newly decoded scalar types, recursive array/range/domain
  handling, and the removal of the `<type>` placeholder in favour of a UTF-8 →
  binary-envelope fallback chain.

## Impact

- **Code**: `packages/app/src-tauri/src/modules/postgres/sql.rs` only —
  `cell_to_json`, new `FromSql` newtypes alongside the existing
  `PgInterval`/`PgInet`/`PgMacAddr`/`PgXid` impls, and the module's `#[cfg(test)]`
  block (which already unit-tests these decoders against hand-built raw byte
  slices).
- **Dependencies**: none added. Decoding is hand-rolled from the documented
  binary wire formats, matching the existing `PgInterval`/`PgInet`/`PgMacAddr`
  pattern, so no new `tokio-postgres` feature (`with-rust_decimal-1`) and no
  direct `postgres-protocol` dependency with its version-pin/duplicate risk.
- **APIs**: `postgres_run_sql`, `postgres_run_sql_many` and
  `postgres_run_sql_stream` return more accurate cell values; the envelope shape,
  column metadata, row cap and `truncated_columns` contracts are unchanged.
- **Out of scope**: composite (`Kind::Composite`), `tsvector`/`tsquery` and other
  exotic types keep falling through to the new UTF-8 → binary-envelope chain
  rather than getting bespoke decoders. The table browser (`data.rs`) is
  untouched. MySQL/MSSQL/Athena editors are unaffected — the defect is specific
  to Postgres binary result decoding.
