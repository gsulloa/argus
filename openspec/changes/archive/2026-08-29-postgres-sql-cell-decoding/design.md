## Context

`cell_to_json` (`packages/app/src-tauri/src/modules/postgres/sql.rs:509`) turns one
`tokio_postgres::Row` cell into a `JsonValue` for the SQL editor result grid. It is
a three-stage pipeline:

1. A `match *pg_type` over known OIDs, each arm doing `row.try_get::<_, Option<T>>(idx)`.
2. A generic `row.try_get::<_, Option<String>>(idx)` fallback (with truncation envelope).
3. `JsonValue::String(format!("<{}>", pg_type.name()))` — the placeholder.

Three facts constrain the fix:

- **Results arrive in binary, not text.** `tokio-postgres` 0.7.17 passes
  `Some(1)` as the result-format argument to `frontend::bind`
  (`query.rs:294-331`), so every column comes back in binary format. The issue's
  suggested "retry raw bytes as UTF-8" therefore *cannot* work for `numeric` —
  the wire payload is a packed base-10000 digit array, not ASCII. Any real fix
  must decode the binary wire format.
- **`FromSql for String` is narrow.** `postgres-types` 0.2.13 accepts only
  `VARCHAR`, `TEXT`, `BPCHAR`, `NAME`, `UNKNOWN`, `citext`, `ltree`/`lquery`/
  `ltxtquery`, and `Kind::Enum` (`lib.rs:719-740`). `NUMERIC` — and domains over
  text — are not among them, so stage 2 returns `Err` and stage 3 fires.
- **There is no numeric decoder available.** `tokio-postgres` is declared with
  only `with-serde_json-1`, `with-time-0_3`, `with-uuid-1`
  (`packages/app/src-tauri/Cargo.toml:38`). `bigdecimal` 0.3 is a direct dep but
  pinned to tiberius/MSSQL `DECIMAL` and not bridged to Postgres.

The file already establishes the pattern to follow: `PgInterval`, `PgXid`,
`PgXid8`, `PgInet` and `PgMacAddr` are hand-rolled `FromSql` newtypes over raw
big-endian bytes, grouped under the "Newtype FromSql decoders for types not
handled by tokio-postgres builtins" banner (`sql.rs:294`), each covered by
`#[cfg(test)]` unit tests that call `T::from_sql(&PgType::X, &raw)` on hand-built
byte slices (`sql.rs:1919-2090`). No live database is required to test them.

## Goals / Non-Goals

**Goals:**

- `numeric` / `decimal` renders its **exact** value in the SQL editor, at full
  arbitrary precision, for every row.
- The other types that fall through today — `money`, arrays, `timetz`,
  `bit`/`varbit`, the geometric family, ranges, domains — render usefully.
- Fix the *fallback*, not just the `numeric` special case: a new type that
  Argus has never seen should degrade to something honest rather than `<type>`.
- Zero new crate dependencies and zero new `tokio-postgres` features.
- Every decoder unit-testable offline from raw bytes, matching the existing
  `PgInterval` test style.

**Non-Goals:**

- Bespoke decoders for composite types (`Kind::Composite`), `tsvector`/`tsquery`,
  `pg_lsn`, `txid_snapshot`, or PostGIS types. They land on the new fallback chain.
- Any change to the table browser (`data.rs`) — its `::text` cast path is already
  correct and is what makes the grid work today.
- Any change to MySQL / MSSQL / Athena SQL editors.
- Any frontend change. See D6.
- Preserving `numeric` as a JSON *number*. See D2.

## Decisions

### D1 — Hand-roll the `NUMERIC` decoder instead of enabling `with-rust_decimal-1` or bridging `bigdecimal`

Add `struct PgNumeric(String)` with a `FromSql` impl over the `numeric_send` wire
format, next to `PgInterval`/`PgInet`/`PgMacAddr`:

```
int16  ndigits          number of base-10000 digit groups
int16  weight           base-10000 exponent of digits[0]
uint16 sign             0x0000 pos · 0x4000 neg · 0xC000 NaN · 0xD000 +Inf · 0xF000 -Inf
int16  dscale           digits after the decimal point
int16 × ndigits         digit groups, each 0..=9999
```

Rendering, which must be exact:

- Special signs short-circuit to `"NaN"`, `"Infinity"`, `"-Infinity"` (Postgres'
  own text spellings).
- Digit group `i` carries base-10000 exponent `weight - i`; equivalently, exponent
  `e` lives at index `weight - e`, and any index outside `0..ndigits` is an
  implicit `0`. This one rule handles leading-zero groups (`weight < -1`) and
  trailing-zero groups (`dscale` beyond `ndigits`) without special cases.
- Integer part: exponents `weight` down to `0`; the first group prints unpadded,
  the rest zero-padded to 4. `weight < 0` ⇒ integer part is `"0"`.
- Fractional part: exponents `-1, -2, …`, each zero-padded to 4, concatenated,
  then truncated **or** zero-padded to exactly `dscale` characters. `dscale == 0`
  ⇒ no decimal point.
- `ndigits == 0` ⇒ the value is zero; still honour `dscale` (`0`, `0.00`, …).
- Negative sign prefixes the result.

Validate `raw.len() >= 8` and `raw.len() == 8 + 2 * ndigits`, and reject
`ndigits < 0`; return `Err` otherwise so the caller falls through rather than
panicking on a slice index.

*Alternatives considered.* (a) `tokio-postgres` feature `with-rust_decimal-1`:
`rust_decimal` is a 96-bit fixed-point type and **cannot** represent the full
`numeric` range — it silently errors or loses precision on values Postgres accepts,
which is the exact failure mode we are trying to avoid. (b) A `bigdecimal` bridge:
`bigdecimal` 0.3 is pinned to tiberius' requirement (`Cargo.toml:65`); the
Postgres bridge crate wants a different major, so wiring it risks two `bigdecimal`
copies in the lock file — the same duplication the codebase already flags for
rustls in the `tiberius` comment. (c) `postgres-protocol` as a direct dependency
for its wire helpers: it is transitive today and not re-exported by
`tokio_postgres`, so declaring it directly means pinning a version that must stay
in lockstep with `tokio-postgres`'s own — new breakage surface for ~40 lines of
parsing we can write ourselves. The hand-rolled decoder has none of these
problems and matches five existing precedents in the same file.

### D2 — `numeric` becomes a JSON **string**, not a JSON number

`serde_json::Number` is `i64`/`u64`/`f64`. `numeric` is arbitrary-precision by
definition; routing it through `f64` silently corrupts money and high-precision
values, which the issue explicitly rules out. The exact decimal string is the only
lossless option.

This is also the *consistent* choice: the table browser already returns `numeric`
as a string (it casts `::text` server-side via `text_castable`, `data.rs:409-411`),
so after this change the SQL editor and the grid agree on the same column.

### D3 — A raw-bytes escape hatch plus a recursive `decode_raw` dispatcher

`Row` exposes no public raw-byte accessor, but `try_get` is generic over
`FromSql<'a>` and `Row::try_get<'a>(&'a self, …)` supports borrowed output. So a
newtype whose `accepts` is total gives us the bytes for **any** type:

```rust
struct PgRaw<'a>(&'a [u8]);
impl<'a> FromSql<'a> for PgRaw<'a> {
    fn from_sql(_ty: &PgType, raw: &'a [u8]) -> Result<Self, …> { Ok(PgRaw(raw)) }
    fn accepts(_ty: &PgType) -> bool { true }
}
```

On top of it, `fn decode_raw(ty: &PgType, raw: &[u8]) -> Option<JsonValue>` — a
pure, recursive, DB-free function that is the single place new types get added:

- Scalars delegate to the same newtype decoders used by the fast path
  (`PgNumeric`, `PgMoney`, `PgTimeTz`, `PgBits`, geometry) plus the primitives
  (`bool`, `i16/i32/i64`, `f32/f64`, `Uuid`, the `time` types, `text`).
- `Kind::Domain(inner)` ⇒ `decode_raw(inner, raw)`. Domains share their base
  type's wire format exactly, so this is a pure delegation — and it is why a
  domain over `text` (rejected by `FromSql for String`) starts working too.
- `Kind::Array(elem)` ⇒ parse `array_send`:
  `int32 ndim`, `int32 has_null`, `int32 elem_oid`, then `ndim × (int32 len, int32 lower_bound)`,
  then per element `int32 len` (`-1` ⇒ SQL NULL) followed by `len` bytes. Each
  element goes through `decode_raw(elem, bytes)`; an element that fails to decode
  becomes `JsonValue::Null` rather than failing the whole cell. `ndim == 0` ⇒ `[]`.
  Multi-dimensional arrays fold the flat element list back into nested
  `JsonValue::Array`s per the dimension lengths, so `int4[][]` reads as nested JSON.
- `Kind::Range(base)` ⇒ parse `range_send`: `uint8 flags`
  (`0x01` empty, `0x02` lower-inclusive, `0x04` upper-inclusive, `0x08`
  lower-infinite, `0x10` upper-infinite — inclusivity comes *before* infinity in
  `rangetypes.h`), then each finite bound as `int32 len` + bytes. Render
  Postgres' own text form — `"empty"`, or `[lo,hi)` with infinite bounds written as
  the empty string — with each bound rendered via `decode_raw(base, …)`.
- `Kind::Multirange(base)` ⇒ `int32 count` followed by `count` range payloads,
  rendered as `{[a,b),[c,d)}`.
- Everything else ⇒ `None`, which triggers D4.

*Alternative considered.* Re-running the statement with `::text` casts, or routing
through `simple_query` (which uses the text protocol and would sidestep binary
decoding entirely). Rejected: `simple_query` returns *every* column as a string —
it would regress ints, floats, booleans and JSON from typed values to text across
the whole editor — and re-running user SQL is unacceptable for statements with
side effects.

### D4 — Retire the `<type>` placeholder for a UTF-8 → binary-envelope chain

When `decode_raw` returns `None`, `cell_to_json` tries, in order:

1. `std::str::from_utf8(raw)`, **plus a control-character guard** (nothing below
   0x20 except tab/newline/CR) — correct for the types whose binary
   representation *is* their text representation: `xml`, `ltree`/`lquery`,
   `pg_lsn`, unrecognised extension text types. The guard was added after live
   verification: `tsvector`'s length-prefixed payload is valid UTF-8 and was
   rendering as a run of ` ` escapes. Postgres `text` cannot contain a NUL,
   so the guard never rejects a real text value.
2. The existing `binary_envelope(hex, raw.len())` — the same `{kind: "binary",
   preview, byte_length}` shape the frontend already renders for `BYTEA`, hex
   preview capped at the current 64 bytes, with the column pushed onto
   `truncated_columns`.

`format!("<{}>", pg_type.name())` is deleted. A placeholder tells the user the
type they can already see in the column header while hiding the value; the hex
envelope is honest, copyable, and reuses a rendering path the grid already has.

### D5 — Where truncation applies

`decode_raw` stays pure — no `truncated_columns` threading, no envelope logic — so
it remains a trivially unit-testable function. `cell_to_json` applies the size
guard to whatever comes back:

- `JsonValue::String(s)` longer than `INLINE_TRUNCATE_BYTES` (1 MiB) ⇒ the
  existing `truncated_envelope(preview, s.len())` with a 2048-char preview, and
  the column recorded — identical to the current stage-2 behaviour.
- A composite value (array / nested array) whose `serde_json::to_string` length
  exceeds `INLINE_TRUNCATE_BYTES` ⇒ the same `truncated_envelope` over the
  serialised preview. This bounds a pathological `text[]` without making the
  decoder impure or truncating every element individually.

### D6 — No frontend work

`sortResultRows` / `compareCellValues`
(`packages/app/src/platform/table/sortResultRows.ts:97-140`) is already
value-aware and its `toNumber` parses numeric-looking **strings** (added for
Athena's string-coerced cells), so string `numeric` sorts numerically for free.
Column-width measurement and cell rendering are type-agnostic, and the
`{kind: "binary"}` / `{kind: "truncated"}` envelopes are existing shapes. Nothing
in `packages/app/src` needs to change; this is a backend-only fix.

### D7 — `money` renders with two decimal places, no currency symbol

`cash_send` emits a bare `int64` in the smallest currency unit; the scale comes
from the server's `lc_monetary` `frac_digits`, which is **not** on the wire.
Assume 2 — correct for the `C` locale and effectively every locale Argus will meet
— and render `-1234567` as `-12345.67`. No `$`/`€` prefix and no thousands
separators: the cell must stay machine-parseable for copy/export, and the grid
sorts it numerically as a result. Document the locale assumption in the decoder's
doc comment.

## Risks / Trade-offs

- **Hand-rolled binary parsing can panic on malformed input** → Every decoder
  validates length before slicing and returns `Err`/`None` instead of indexing
  blindly; `decode_raw` propagates `None` to D4's fallback chain. Unit tests
  include short/truncated buffers asserting `is_err()`, mirroring the existing
  `PgInterval` bad-length test (`sql.rs:1981`).
- **`money`'s scale is an assumption** (D7) → A non-2-`frac_digits` locale would
  render off by a factor of 10. Accepted: it is still vastly better than
  `<money>`, and the assumption is documented at the call site.
- **`numeric` as a string could surprise a consumer expecting a number** (D2) →
  It already *is* a string in the table browser for the same column, and the
  frontend sorts numeric strings correctly (D6). The alternative — `f64` — is a
  silent-corruption bug in money columns.
- **Multi-dimensional / deeply nested arrays could allocate a lot** → The array
  parser only ever walks the bytes Postgres already sent (bounded by the existing
  row cap), and D5's serialized-size guard caps the JSON that reaches the
  frontend.
- **`decode_raw`'s recursion is unbounded in principle** (domain → domain →
  range → array …) → Postgres type graphs are acyclic and shallow, but cap
  recursion depth (e.g. 8) and return `None` past it so a hostile or exotic
  catalog cannot blow the stack.
- **Regressing a currently-working type** → The stage-1 fast paths and the
  stage-2 `String` path are untouched; the new code only runs where `<type>` is
  produced today. Existing `cell_to_json`-adjacent tests must keep passing
  unchanged, which is the regression signal.

## Migration Plan

Pure bug fix inside one Rust function — no schema change, no persisted state, no
API shape change. Ships in the normal release; rollback is a revert of the single
file.

## Open Questions

None blocking. `Kind::Composite` decoding is deliberately deferred (D3/Non-Goals);
if users hit it, it is an additive follow-up to `decode_raw` with no contract change.
