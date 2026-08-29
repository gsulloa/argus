All work is in `packages/app/src-tauri/src/modules/postgres/sql.rs`. New decoders go
under the existing "Newtype FromSql decoders for types not handled by
tokio-postgres builtins" banner (`sql.rs:294`); new tests go in the existing
`#[cfg(test)] mod tests` block (`sql.rs:1579`), following the `PgInterval` style of
calling `T::from_sql(&PgType::X, &raw)` on hand-built byte slices — no live
database needed.

## 1. Exact NUMERIC decoder

- [x] 1.1 Add `struct PgNumeric(String)` with a `FromSql` impl over the
      `numeric_send` wire format: `int16 ndigits`, `int16 weight`,
      `uint16 sign`, `int16 dscale`, then `ndigits × int16` base-10000 groups.
      Validate `raw.len() >= 8`, `ndigits >= 0`, and `raw.len() == 8 + 2 * ndigits`;
      return `Err` (never panic / never slice blindly) otherwise.
- [x] 1.2 Short-circuit the special signs: `0xC000` → `"NaN"`, `0xD000` →
      `"Infinity"`, `0xF000` → `"-Infinity"`. `0x4000` sets the negative flag.
- [x] 1.3 Implement exact rendering per design D1: digit group `i` has base-10000
      exponent `weight - i`, so exponent `e` reads index `weight - e` with any
      out-of-range index treated as `0`. Integer part = exponents `weight..=0`
      (first group unpadded, rest zero-padded to 4; `"0"` when `weight < 0`);
      fractional part = exponents `-1, -2, …` zero-padded to 4, concatenated,
      then padded/truncated to exactly `dscale` chars. Emit no decimal point when
      `dscale == 0`; prefix `-` when negative; handle `ndigits == 0` as zero at
      the declared scale.
- [x] 1.4 Add `PgType::NUMERIC` to the fast-path `match` in `cell_to_json`, ahead
      of the `String` fallback, returning `JsonValue::String(v.0)`.
- [x] 1.5 Unit-test `PgNumeric::from_sql` for: `1234.56`, `1234.5600`
      (scale 4), `42` (scale 0), `0.00` (scale 2 with `ndigits == 0`),
      `0.00001` (leading zero groups, `weight < -1`),
      `-12345678901234567890.123456789`, `NaN`, `Infinity`, `-Infinity`,
      and a truncated buffer asserting `is_err()`.

## 2. Remaining scalar decoders

- [x] 2.1 Add `PgMoney` — `int64` scaled by 2 decimal places, rendered without
      currency symbol or separators (`-1234567` → `"-12345.67"`). Document the
      `lc_monetary frac_digits == 2` assumption (design D7) in the doc comment.
      Wire `PgType::MONEY` into the fast-path match.
- [x] 2.2 Add `PgTimeTz` — `int64` microseconds since midnight + `int32` zone in
      seconds **west** of UTC; render `HH:MM:SS[.ffffff]±HH:MM` with the offset
      negated for display. Wire `PgType::TIMETZ` in.
- [x] 2.3 Add `PgBits` — `int32` bit length then `ceil(len/8)` MSB-first bytes;
      render exactly `len` `'0'`/`'1'` characters. Wire `PgType::BIT | PgType::VARBIT` in.
- [x] 2.4 Add the geometric decoders producing Postgres text form: `POINT` `(x,y)`;
      `LSEG` `[(x1,y1),(x2,y2)]`; `BOX` `(x1,y1),(x2,y2)`; `LINE` `{A,B,C}`;
      `PATH` (`int8` closed flag + `int32 npts` + points) `((…))` when closed and
      `[(…)]` when open; `POLYGON` (`int32 npts` + points) `((…))`;
      `CIRCLE` `<(x,y),r>`. Format floats with Rust's shortest round-trip `Display`.
      Wire all seven into the fast-path match.
- [x] 2.5 Every decoder in this group validates its buffer length before reading.
- [x] 2.6 Unit-test each: one representative value plus one short-buffer
      `is_err()` case (money negative and positive, timetz with a positive and a
      negative offset, varbit with a non-byte-multiple length such as `1011`,
      point, and one variable-length geometry such as an open vs closed path).

## 3. Raw-bytes escape hatch and recursive dispatcher

- [x] 3.1 Add `struct PgRaw<'a>(&'a [u8])` with `FromSql<'a>` whose `accepts`
      returns `true` for every type and whose `from_sql` returns the bytes
      verbatim, so `row.try_get::<_, Option<PgRaw>>(idx)` yields raw bytes for
      any column.
- [x] 3.2 Add `fn decode_raw(ty: &PgType, raw: &[u8], depth: usize) -> Option<JsonValue>`
      — pure, DB-free, no `truncated_columns` threading. Dispatch scalars to the
      decoders from groups 1–2 plus the primitives already handled
      (`bool`, `int2/4/8`, `float4/8`, `json`/`jsonb`, `uuid`, the `time` types,
      `text`/`varchar`/`bpchar`/`name`). Return `None` past a recursion depth cap
      of 8.
- [x] 3.3 `Kind::Domain(inner)` ⇒ `decode_raw(inner, raw, depth + 1)`.
- [x] 3.4 `Kind::Array(elem)` ⇒ parse `array_send`: `int32 ndim`, `int32 has_null`,
      `int32 elem_oid`, `ndim × (int32 dim_len, int32 lower_bound)`, then per
      element `int32 len` (`-1` ⇒ SQL NULL) + `len` bytes. Decode each element via
      `decode_raw(elem, …, depth + 1)`, mapping a failed element to
      `JsonValue::Null`. `ndim == 0` ⇒ `[]`. For `ndim > 1`, fold the flat element
      list into nested `JsonValue::Array`s per the dimension lengths.
- [x] 3.5 `Kind::Range(base)` ⇒ parse `range_send`: `uint8` flags (`0x01` empty,
      `0x02` lower-**inclusive**, `0x04` upper-**inclusive**, `0x08` lower-inf,
      `0x10` upper-inf — inclusivity before infinity, per `rangetypes.h`; this
      plan originally had the two pairs swapped, which live verification caught)
      then each finite bound as `int32 len` + bytes.
      Render `"empty"`, or `[lo,hi)`-style with bracket/paren from inclusivity,
      infinite bounds as the empty string, and each bound rendered via
      `decode_raw(base, …, depth + 1)` (unquoted string form).
- [x] 3.6 `Kind::Multirange(base)` ⇒ `int32 count` + `count` range payloads,
      rendered `{[a,b),[c,d)}`, `{}` when empty.
- [x] 3.7 Everything else ⇒ `None`.
- [x] 3.8 Unit-test `decode_raw` from hand-built bytes: `int4[]` with a NULL
      element, `text[]`, `numeric(10,2)[]` (proves scalar reuse inside a
      container), empty array, 2-D `int4[][]` nesting, `int4range` `[1,5)`,
      `empty` range, an unbounded range `[1,)`, a domain over `numeric`, a domain
      over `text`, and depth-cap exhaustion returning `None`.

## 4. Rewire `cell_to_json` and retire the placeholder

- [x] 4.1 Replace the last-resort `JsonValue::String(format!("<{}>", pg_type.name()))`
      (`sql.rs:665`) with the raw path: `row.try_get::<_, Option<PgRaw>>(idx)` →
      `None` ⇒ `JsonValue::Null`; `Some(raw)` ⇒ `decode_raw(pg_type, raw, 0)`.
- [x] 4.2 When `decode_raw` returns `None`, fall back in order to (a)
      `std::str::from_utf8(raw)` as a `JsonValue::String`, then (b)
      `binary_envelope(hex_of_first_64_bytes, raw.len())` with `column_name`
      pushed onto `truncated_columns` (dedup as the existing `BYTEA` arm does).
- [x] 4.3 Delete the `format!("<{}>", …)` expression entirely and confirm
      `rg '<\{\}>' packages/app/src-tauri/src` returns nothing.
- [x] 4.4 Apply the size guard (design D5) to the raw path's result: a
      `JsonValue::String` longer than `INLINE_TRUNCATE_BYTES` ⇒
      `truncated_envelope(2048-char preview, len)` + column recorded; any other
      value whose `serde_json::to_string` length exceeds `INLINE_TRUNCATE_BYTES` ⇒
      `truncated_envelope` over the serialised preview + column recorded.
- [x] 4.5 Leave stages 1 and 2 (the existing fast-path match arms and the
      `String` fallback with its truncation envelope) otherwise untouched, so no
      currently-working type changes shape.

## 5. Verification

- [x] 5.1 `cargo fmt` and `cargo clippy` clean for the crate (no new warnings).
- [x] 5.2 `cargo test -p <app crate> postgres::sql` — all new unit tests pass and
      every pre-existing test in the module still passes unchanged.
- [x] 5.3 Frontend untouched: confirm no file under `packages/app/src` is modified
      (design D6 — `compareCellValues`/`toNumber` already sorts numeric strings,
      and the `binary`/`truncated` envelopes are existing shapes).
- [x] 5.4 Manual check against a real Postgres connection: run
      `SELECT 1234.56::numeric, 0.00001::numeric, 'NaN'::numeric, (-12345.67)::money,
      ARRAY[1,2,NULL]::int4[], '[1,5)'::int4range, B'1011'::varbit, '(1,2)'::point,
      '12:34:56.789+02'::timetz` in the SQL editor and confirm no cell renders as
      `<type>`; then browse the same `numeric` column through the schema tree and
      confirm the two paths now agree.
- [x] 5.5 Update `CHANGELOG.md` under Unreleased → Fixed, referencing #291.
