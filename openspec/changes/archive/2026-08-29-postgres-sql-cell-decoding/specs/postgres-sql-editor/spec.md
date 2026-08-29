## ADDED Requirements

### Requirement: Exact NUMERIC cell decoding

For `kind: "rows"` results, every cell of a `numeric` / `decimal` column (Postgres
OID `NUMERIC`) SHALL be returned as a JSON **string** holding the value's exact
decimal text, byte-for-byte equivalent to what Postgres' own `numeric_out` would
produce for that value and `dscale`. The decoder MUST operate on the binary wire
format (`tokio-postgres` requests binary result format for every column) and MUST
NOT route the value through `f64`, `f32`, or any fixed-width decimal type, so
arbitrary precision and trailing scale are preserved exactly.

The decoder MUST honour the declared scale (`dscale`): the fractional part is
rendered to exactly `dscale` digits, zero-padded or truncated as needed, and no
decimal point is emitted when `dscale` is `0`. The special sign encodings MUST
render as `"NaN"`, `"Infinity"` and `"-Infinity"`.

A malformed or short `NUMERIC` payload MUST NOT panic; the decoder MUST fail
cleanly and let the cell fall through to the undecodable-cell fallback.

This requirement also applies to `numeric` reached through a domain, an array
element, or a range bound.

#### Scenario: numeric column renders its value, not a placeholder

- **WHEN** the user runs `SELECT 1234.56::numeric` in the Postgres SQL editor
- **THEN** the cell value is the string `"1234.56"`
- **AND** no cell in the result equals `"<numeric>"`

#### Scenario: declared scale is preserved

- **WHEN** the user runs `SELECT 1234.56::numeric(10,4)`
- **THEN** the cell value is the string `"1234.5600"`

#### Scenario: zero scale renders without a decimal point

- **WHEN** the user runs `SELECT 42::numeric(10,0)`
- **THEN** the cell value is the string `"42"`

#### Scenario: arbitrary precision survives without f64 rounding

- **WHEN** the user runs `SELECT '-12345678901234567890.123456789'::numeric`
- **THEN** the cell value is the string `"-12345678901234567890.123456789"`

#### Scenario: small magnitudes with leading zero groups

- **WHEN** the user runs `SELECT 0.00001::numeric`
- **THEN** the cell value is the string `"0.00001"`

#### Scenario: NaN and infinities render as Postgres spells them

- **WHEN** the user runs `SELECT 'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric`
- **THEN** the cell values are the strings `"NaN"`, `"Infinity"` and `"-Infinity"`

#### Scenario: zero with scale

- **WHEN** the user runs `SELECT 0::numeric(10,2)`
- **THEN** the cell value is the string `"0.00"`

#### Scenario: malformed numeric payload does not panic

- **WHEN** the `NUMERIC` decoder is given a payload shorter than its declared digit count
- **THEN** it returns an error rather than panicking
- **AND** the cell falls through to the undecodable-cell fallback

### Requirement: Decoding of previously unsupported scalar types

For `kind: "rows"` results, the following Postgres types SHALL be decoded to their
value rather than a type placeholder:

- `money` → decimal string with two fractional digits, no currency symbol and no
  thousands separators (e.g. `"-12345.67"`). The two-digit scale is an assumption
  about the server's `lc_monetary` `frac_digits`, which is not carried on the wire.
- `timetz` → `HH:MM:SS[.ffffff]±HH:MM`, where the offset is the UTC offset (the
  wire field is seconds *west* of UTC and MUST be negated for display).
- `bit` / `varbit` → a string of `'0'`/`'1'` characters whose length equals the
  value's declared bit length.
- `point` → `(x,y)`; `lseg` → `[(x1,y1),(x2,y2)]`; `box` → `(x1,y1),(x2,y2)`;
  `line` → `{A,B,C}`; `path` → `((x1,y1),…)` when closed and `[(x1,y1),…]` when
  open; `polygon` → `((x1,y1),…)`; `circle` → `<(x,y),r>`.

Each decoder MUST validate payload length before reading and MUST fail cleanly
(never panic) on a short or malformed buffer.

#### Scenario: money renders its amount

- **WHEN** the user runs `SELECT (-12345.67)::money`
- **THEN** the cell value is the string `"-12345.67"`
- **AND** it is not `"<money>"`

#### Scenario: timetz renders time and UTC offset

- **WHEN** the user runs `SELECT '12:34:56.789+02'::timetz`
- **THEN** the cell value is the string `"12:34:56.789000+02:00"`

#### Scenario: varbit renders its bits

- **WHEN** the user runs `SELECT B'1011'::varbit`
- **THEN** the cell value is the string `"1011"`

#### Scenario: point renders in Postgres text form

- **WHEN** the user runs `SELECT '(1,2)'::point`
- **THEN** the cell value is the string `"(1,2)"`

#### Scenario: malformed geometric payload does not panic

- **WHEN** a geometric decoder is given a buffer shorter than its fixed width
- **THEN** it returns an error rather than panicking

### Requirement: Recursive decoding of arrays, ranges, and domains

For `kind: "rows"` results, container-kind Postgres types SHALL be decoded by
recursing into their element or base type, so any type covered elsewhere in this
capability is also covered inside a container:

- **Arrays** (`Kind::Array`) MUST decode to a JSON array. A SQL `NULL` element
  MUST become JSON `null`. An empty array MUST become `[]`. A multi-dimensional
  array MUST be nested according to its dimension lengths. An element whose own
  decode fails MUST become `null` rather than failing the whole cell.
- **Ranges** (`Kind::Range`) MUST decode to Postgres' text form: `"empty"` for the
  empty range, otherwise `[lo,hi)`-style with the bracket/parenthesis reflecting
  inclusivity and an infinite bound written as the empty string. Each finite bound
  MUST be rendered by decoding it as the range's base type.
- **Multiranges** (`Kind::Multirange`) MUST decode to `{[a,b),[c,d)}` over their
  constituent ranges, and `{}` when empty.
- **Domains** (`Kind::Domain`) MUST decode as their underlying base type, since a
  domain shares its base type's wire format.

Recursion depth MUST be bounded; a value nested beyond the bound MUST fall through
to the undecodable-cell fallback rather than exhausting the stack.

#### Scenario: integer array decodes to a JSON array

- **WHEN** the user runs `SELECT ARRAY[1,2,NULL]::int4[]`
- **THEN** the cell value is the JSON array `[1, 2, null]`
- **AND** it is not `"<_int4>"`

#### Scenario: text array decodes to a JSON array of strings

- **WHEN** the user runs `SELECT ARRAY['a','b']::text[]`
- **THEN** the cell value is the JSON array `["a", "b"]`

#### Scenario: numeric array preserves exact values

- **WHEN** the user runs `SELECT ARRAY[1.10, 2.20]::numeric(10,2)[]`
- **THEN** the cell value is the JSON array `["1.10", "2.20"]`

#### Scenario: empty array decodes to an empty JSON array

- **WHEN** the user runs `SELECT ARRAY[]::int4[]`
- **THEN** the cell value is the JSON array `[]`

#### Scenario: multi-dimensional array nests

- **WHEN** the user runs `SELECT ARRAY[[1,2],[3,4]]::int4[][]`
- **THEN** the cell value is the JSON array `[[1, 2], [3, 4]]`

#### Scenario: range decodes to its text form

- **WHEN** the user runs `SELECT '[1,5)'::int4range`
- **THEN** the cell value is the string `"[1,5)"`

#### Scenario: empty range decodes to empty

- **WHEN** the user runs `SELECT 'empty'::int4range`
- **THEN** the cell value is the string `"empty"`

#### Scenario: unbounded range renders an empty bound

- **WHEN** the user runs `SELECT '[1,)'::int4range`
- **THEN** the cell value is the string `"[1,)"`

#### Scenario: domain decodes as its base type

- **WHEN** the user runs a `SELECT` returning a column of a domain declared over
  `numeric(10,2)` whose value is `1.50`
- **THEN** the cell value is the string `"1.50"`

#### Scenario: domain over text decodes as text

- **WHEN** the user runs a `SELECT` returning a column of a domain declared over
  `text` whose value is `abc`
- **THEN** the cell value is the string `"abc"`

### Requirement: Undecodable cell fallback

The Postgres SQL editor SHALL NOT return a `<typename>` placeholder for any cell.
When a cell's Postgres type has no decoder, the backend MUST fall back, in order,
to:

1. The raw payload interpreted as UTF-8, returned as a JSON string, when the bytes
   are valid UTF-8 **and** contain no control characters other than tab, newline
   and carriage return — correct for types whose binary representation is their
   text representation (`xml`, `ltree`, `pg_lsn`, unrecognised extension text
   types). The control-character guard is what keeps a structured binary payload
   that merely happens to be valid UTF-8 (`tsvector` is length-prefixed) from
   rendering as a run of escapes; Postgres `text` cannot contain a NUL byte, so
   the guard never rejects a real text value.
2. The existing binary envelope `{ kind: "binary", preview: <hex>, byte_length: <n> }`
   — the same shape already returned for `bytea` — with the column name recorded
   in the response's `truncated_columns`.

A SQL `NULL` MUST still return JSON `null` and MUST NOT enter this fallback chain.

Size limits are applied after decoding, matching the existing behaviour: a decoded
string longer than the inline-truncate limit MUST be returned as the existing
`{ kind: "truncated", preview, byte_length }` envelope with its column recorded in
`truncated_columns`, and a decoded container value whose JSON serialisation
exceeds the same limit MUST be returned as that truncated envelope over the
serialised preview.

The types already decoded before this change — `bool`, `int2`/`int4`/`int8`,
`float4`/`float8`, `json`/`jsonb`, `bytea`, `date`, `time`, `timestamp`,
`timestamptz`, `uuid`, `oid`, `xid`, `xid8`, `interval`, `inet`/`cidr`,
`macaddr`/`macaddr8`, and the text family — MUST keep their current JSON shapes,
including their truncation and binary envelopes.

#### Scenario: no placeholder is ever emitted

- **WHEN** any `SELECT` completes in the Postgres SQL editor
- **THEN** no cell value matches the pattern `<typename>` produced by the former
  last-resort branch

#### Scenario: unknown text-shaped type falls back to UTF-8

- **WHEN** the user runs `SELECT '<a/>'::xml`
- **THEN** the cell value is the string `"<a/>"`

#### Scenario: unknown binary-shaped type falls back to the binary envelope

- **WHEN** the user runs a `SELECT` returning a column of a type with no decoder
  whose payload is not valid printable UTF-8 — e.g. `'tsv'::tsvector`, whose
  length-prefixed payload is valid UTF-8 but riddled with NUL bytes
- **THEN** the cell value is `{ kind: "binary", preview: <hex prefix>, byte_length: <n> }`
- **AND** the column name appears in the response's `truncated_columns`

#### Scenario: NULL stays null

- **WHEN** the user runs `SELECT NULL::numeric, NULL::int4[], NULL::money`
- **THEN** every cell value is JSON `null`

#### Scenario: previously working types are unchanged

- **WHEN** the user runs `SELECT true, 1::int4, 1.5::float8, '{"a":1}'::jsonb, now(), gen_random_uuid()`
- **THEN** the cells are, respectively, JSON `true`, JSON `1`, JSON `1.5`, the JSON
  object `{"a":1}`, an RFC 3339 string, and a UUID string — the same shapes as
  before this change

### Requirement: Decoding applies to every rows-returning Postgres run path

The decoding rules in this capability SHALL apply identically to
`postgres_run_sql`, to each rows-returning statement of `postgres_run_sql_many`,
and to the `batch` events of `postgres_run_sql_stream`, since all three build cells
through the same conversion.

#### Scenario: multi-statement run decodes numeric in every statement

- **WHEN** the user invokes `postgres.runSqlMany(id, ["SELECT 1.50::numeric", "SELECT 2.50::numeric"], "user")`
- **THEN** entry 0's first cell is `"1.50"` and entry 1's first cell is `"2.50"`

#### Scenario: streaming run decodes numeric in batch events

- **WHEN** the user runs a streaming `SELECT` over a `numeric` column
- **THEN** every `batch` event's cells hold the exact decimal strings, not `"<numeric>"`
