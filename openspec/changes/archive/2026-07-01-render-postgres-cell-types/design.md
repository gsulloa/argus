## Context

The Postgres value serializer `cell_to_json` (`packages/app/src-tauri/src/modules/postgres/sql.rs`, lines ~216–343) converts each `tokio_postgres::Row` cell into a `serde_json::Value`. It matches on `pg_type` for common scalars (bool, ints, floats, json, bytea, timestamp family, uuid), then falls back to `try_get::<Option<String>>`, and — as a last resort — emits `JsonValue::String(format!("<{}>", pg_type.name()))` (line 342).

`tokio-postgres` requests values in **binary** wire format. The string fallback only succeeds for types that implement `FromSql for String` from their binary representation (text/varchar/name/etc.). Types such as `interval`, `oid`, `inet`, `cidr`, `xid`, `xid8`, `macaddr` do **not**, so they hit the last-resort branch and render as `<interval>`, `<oid>`, `<inet>`, `<xid>`. Users see a placeholder instead of the data.

Confirmed environment (from `Cargo.toml` + research):
- `tokio-postgres` 0.7.17, `postgres-types` 0.2.13; features enabled: `with-serde_json-1`, `with-time-0_3`, `with-uuid-1` only.
- `tokio_postgres::Row` exposes **no** public raw-bytes accessor — all decoding must go through `FromSql`. A newtype wrapper's `from_sql(ty, raw: &[u8])` is the only way to reach the wire bytes.
- Built-in `FromSql`: `u32` accepts `Type::OID` (works for `oid`). `IpAddr` accepts `INET`/`CIDR` but **drops the network prefix** (`/24`). No built-in impl for `interval`, `xid`, `xid8`.

The same serializer backs both the data grid (`postgres_query_table`) and the SQL editor (`postgres_run_sql` / `_many`), so one fix covers both surfaces. MySQL/MSSQL adapters already string-coerce unknown types and are out of scope.

## Goals / Non-Goals

**Goals:**
- Render the real value for `interval`, `oid`, `inet`, `cidr`, `xid`, `xid8`, `macaddr`, `macaddr8` in the Postgres data grid and SQL editor.
- Keep the fix self-contained in `sql.rs`, dependency-free, and faithful (e.g. `inet`/`cidr` preserve their `/prefix`).
- Preserve the existing typed pipeline: numbers stay JSON numbers where natural (`oid`, `xid`, `xid8`); everything else is a readable string.
- Keep `<typename>` only as a genuine last resort for types we still cannot decode (e.g. `tsvector`, geometric types, ranges, user composites).

**Non-Goals:**
- No change to MySQL/MSSQL adapters (already graceful).
- No frontend changes — the grid/editor render whatever scalar/string the backend returns.
- No attempt to decode every exotic Postgres type; only the common, user-reported ones plus their obvious siblings.
- No switch to text wire-format (`simple_query`) or blanket `::text` casting — that would discard the existing typed handling.

## Decisions

### Decision 1: Add explicit match arms with newtype `FromSql` decoders (no new crates)

For each newly-supported type, add an arm to the existing `match *pg_type` block (before the string fallback), mirroring the current arms that `return` early on success and fall through on `Err`.

- **`oid`** → `row.try_get::<_, Option<u32>>(idx)` → `JsonValue::Number`. Uses the built-in `u32` impl; no custom code.
- **`interval`, `xid`, `xid8`, `inet`/`cidr`, `macaddr`/`macaddr8`** → small newtype wrappers implementing `FromSql`, each parsing `raw: &[u8]` per the documented wire format and producing a display string (or number for xid). Because `Row` has no raw accessor, the newtype is the only viable mechanism.

Wire formats used by the decoders:
- `interval` — 16 bytes BE: `i64` microseconds, `i32` days, `i32` months. Formatted to a Postgres-style readable string (e.g. `1 year 2 mons 3 days 04:05:06`, with a `mм`/`days`/`HH:MM:SS[.ffffff]` composition; zero components omitted; sign handled).
- `xid` — 4-byte BE unsigned → `u32` → `JsonValue::Number`. `xid8` — 8-byte BE unsigned → `u64` → `JsonValue::Number` (fits `serde_json::Number`).
- `inet`/`cidr` — header `[family, bits, is_cidr, addr_len]` + address bytes. Reconstruct `Ipv4Addr`/`Ipv6Addr` from `addr_len` bytes and format as `addr/bits`, matching `psql` display (suppress `/32` and `/128` for `inet` hosts; always show the prefix for `cidr`).
- `macaddr` — 6 bytes → `xx:xx:xx:xx:xx:xx`. `macaddr8` — 8 bytes → `xx:xx:xx:xx:xx:xx:xx:xx`.

**Why over alternatives:**
- *vs. feature-bridge crates (`with-cidr-0_3`, `with-eui48-1`) + `pg_interval` crate:* three new dependencies, and `xid`/`xid8` still need custom code regardless — so bridges do not eliminate the newtype work, they only add supply-chain surface. `IpAddr` (already built-in) drops the prefix, which is the exact "I can't see the real value" complaint. Self-contained decoders give faithful output with zero new deps and consistent formatting we control.
- *vs. `simple_query` / text wire format:* would return everything as text and discard the existing typed numeric/json/bytea handling across the whole path — far larger blast radius for a rendering bug.
- *vs. wrapping columns in `::text` in generated SQL:* the SQL editor runs arbitrary user SQL; rewriting projections is intrusive and fragile.

### Decision 2: Keep `<typename>` as a true last resort, and make the fallback resilient

The final branch stays as `format!("<{}>", pg_type.name())` but is now reached only when a value is neither a handled type, nor `String`-decodable, nor one of the newly-decoded types. Each new arm follows the existing `Err(_) => {}` fall-through convention so a decode failure degrades to the string attempt and then the placeholder, never a panic or a lost row. This preserves current behavior for genuinely unsupported types (tsvector, geometric, ranges, composites) while fixing the reported ones.

### Decision 3: Scope the spec delta to the shared serialization contract

The behavior lives in the `postgres-data-grid` capability's `postgres_query_table` value-envelope clause; `postgres-sql-editor` references "the same `Value` envelope handling". The delta tightens that one clause (readable types MUST render their value, not `<typename>`), automatically covering both surfaces without a separate editor delta.

## Risks / Trade-offs

- **Interval formatting differs subtly from `psql`** → Mitigation: target the common `postgres` interval style and cover representative values (year/month/day/time, negative, sub-second) in tests; exact byte-for-byte parity with every `IntervalStyle` is a non-goal.
- **`inet` vs `cidr` prefix display nuance** (psql hides `/32` for inet hosts but shows it for cidr) → Mitigation: branch on `is_cidr` and `bits`; assert both cases in tests.
- **A future/exotic type still shows `<typename>`** → Accepted: the fix is explicitly a targeted improvement, and the placeholder remains an honest signal for the long tail. The generic fallback keeps unknown types from breaking.
- **Newtype decoders parse raw bytes manually** → Mitigation: validate buffer length before indexing; on any length mismatch return a `FromSql` error so the arm falls through gracefully rather than panicking.

## Migration Plan

Pure additive backend change; no data migration, no schema change, no config. Ships in the normal app build. Rollback is a straight revert of the `sql.rs` diff — the response payload shape is unchanged, so no frontend or persisted-state coupling.

## Open Questions

- Interval output format: Postgres-style verbose (`1 year 2 mons 3 days 04:05:06`) vs ISO 8601 (`P1Y2M3DT4H5M6S`). Recommendation: Postgres-style, as it matches what users see in `psql`. Confirm during implementation.
- Whether to also number-ify `oid`/`xid` (JSON number) or keep them as strings for copy-fidelity. Recommendation: numbers, consistent with other integer types; revisit only if the grid's numeric alignment looks wrong for id-like columns.
