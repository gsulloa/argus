## 1. Decoders in `modules/postgres/sql.rs`

- [x] 1.1 Add a private newtype `PgInterval` implementing `tokio_postgres::types::FromSql` that `accepts` `PgType::INTERVAL`, parses the 16-byte wire format (`i64` microseconds, `i32` days, `i32` months, big-endian), validates buffer length, and formats to a Postgres-style string (`1 year 2 mons 3 days 04:05:06`; omit zero components; handle negatives and sub-second microseconds).
- [x] 1.2 Add newtypes `PgXid` (4-byte BE `u32`) and `PgXid8` (8-byte BE `u64`) implementing `FromSql` for `PgType::XID` and `PgType::XID8`, with buffer-length validation.
- [x] 1.3 Add a newtype `PgInet` implementing `FromSql` for `PgType::INET` and `PgType::CIDR` that parses the `[family, bits, is_cidr, addr_len]` header plus address bytes, reconstructs `Ipv4Addr`/`Ipv6Addr`, and formats as `addr/bits` — suppressing `/32` and `/128` for `inet` hosts (`is_cidr == 0`) and always showing the prefix for `cidr`.
- [x] 1.4 Add a newtype `PgMacAddr` implementing `FromSql` for `PgType::MACADDR` (6 bytes) and `PgType::MACADDR8` (8 bytes) that formats to colon-separated lowercase hex.
- [x] 1.5 Ensure each decoder returns a `FromSql` error (not a panic) on any unexpected buffer length so the caller falls through gracefully.

## 2. Wire decoders into `cell_to_json`

- [x] 2.1 Add a `PgType::OID` match arm using the built-in `row.try_get::<_, Option<u32>>(idx)`, returning `JsonValue::Number` on `Ok(Some)`, `Null` on `Ok(None)`, and falling through on `Err` (mirror the existing INT arms).
- [x] 2.2 Add match arms for `INTERVAL`, `XID`, `XID8`, `INET`, `CIDR`, `MACADDR`, `MACADDR8` that `try_get` the corresponding newtype (or `u32`/`u64` for the id types), returning the value string/number, `Null` on `None`, and falling through on `Err`.
- [x] 2.3 Confirm the `xid`/`xid8`/`oid` arms produce `JsonValue::Number` and the rest produce `JsonValue::String`; leave the existing `String` fallback and `<typename>` last-resort branch unchanged so unsupported types still degrade correctly.

## 3. Tests

- [x] 3.1 Add unit tests for each decoder's byte-parsing and formatting (interval incl. negative and sub-second, xid/xid8, inet host, cidr with prefix, ipv6, macaddr, macaddr8, and malformed-length error paths).
- [~] 3.2 Add/extend an integration test asserting `SELECT`s of these types return real values, `NULL` returns JSON `null`, and an undecodable type (e.g. `tsvector`) still returns the `<typename>` envelope. **Adapted:** the module has no live-DB tests — `cell_to_json` needs a real `tokio_postgres::Row` that cannot be built offline. The value-rendering logic (the fix) is fully covered by the decoder unit tests in 3.1; `NULL → null` and unsupported → `<typename>` are guaranteed by the unchanged fallback branches plus the new arms following the identical `Ok(None) => Null` / `Err(_) => {}` convention. End-to-end coverage is the manual step 4.2.

## 4. Verify

- [x] 4.1 Build the Rust backend (`cargo build`) and run the Postgres module tests; confirm no new warnings from the added code.
- [ ] 4.2 Manually verify in the app against a Postgres connection that a table/query with `interval`, `oid`, `inet`, `cidr`, `xid` columns shows real values in both the data grid and the SQL editor result table. **(Requires a live Postgres + running app — left for the user.)**
- [x] 4.3 Run `openspec validate --changes render-postgres-cell-types` and confirm the change passes.
