## Context

`list_columns` records each column type using `pg_catalog.format_type(a.atttypid, a.atttypmod)`. That output is already a valid SQL type expression and includes the quoting PostgreSQL requires. For a mixed-case enum array outside the active search path it can be `"default$default"."FeatureFlags"[]`.

The edit binder currently passes that string through `normalize_pg_type`, which removes modifiers and lowercases every character. The normalized string is useful for recognizing built-ins, but `BindKind::Fallback` also stores it as the SQL cast target. As a result, the generated placeholder changes the catalog identity to `$1::text::"default$default"."featureflags"[]`, and PostgreSQL returns `42704` before it can parse the value.

There is a second issue behind the first. The grid deliberately treats every `[]` column as JSON-shaped, displays it in a textarea, validates it as JSON, and sends a canonical string such as `["beta","dark-mode"]`. A fallback cast binds that as one `String`; PostgreSQL's native array input syntax uses braces, so merely preserving the type name would expose a malformed-array error next.

The constraints are:

- Values must remain parameters; catalog-derived type expressions are the only SQL fragments emitted dynamically.
- Existing scalar bindings, JSON/JSONB behavior, edit payloads, and Tauri commands must remain compatible.
- The UI already provides a reasonable textarea for array editing; an enum-array multi-select is not required for this fix.

## Goals / Non-Goals

**Goals:**

- Preserve the exact catalog identity of scalar and array custom types when generating casts.
- Save one-dimensional arrays entered through the existing JSON textarea, including enum arrays, empty arrays, element-level `null`, and whole-column `NULL`.
- Fail malformed or unsupported array input during bind validation with a column-specific error.
- Keep all data parameterized and cover the generated SQL with pure unit tests.

**Non-Goals:**

- Adding enum-array option discovery, chips, or a multi-select editor.
- Supporting nested/multidimensional arrays or composite/record elements.
- Changing filtering semantics for array columns.
- Repairing rows or schemas in the user's database.
- Replacing `pg_catalog.format_type` or introducing a general PostgreSQL type parser.

## Decisions

### Decision 1: Separate the classification key from the emitted cast target

`bind_kind_for_type` will derive two representations from the raw `data_type`:

1. A lowercase, modifier-free normalized key used only to recognize built-in scalar types.
2. The exact trimmed `format_type` text used by fallback and array casts.

Built-ins continue to map to their existing variants. An unrecognized scalar becomes `BindKind::Fallback(exact_type)`, never `Fallback(normalized_type)`. An array type becomes an explicit `BindKind::Array { target: exact_type }` before scalar classification.

This keeps `normalize_pg_type` useful to the filter and existing tests without allowing its lossy output into SQL. The exact text is safe to embed because it comes from `pg_catalog.format_type`, which returns identifiers with PostgreSQL's own quoting and escaping.

Alternatives considered:

- **Lowercase only outside quoted identifiers.** This still risks changing an unquoted custom identifier's intended catalog spelling and requires a partial SQL lexer.
- **Split and re-quote schema/type names ourselves.** Dots, escaped quotes, arrays, domains, and search-path-dependent output make this a fragile duplicate of PostgreSQL's formatter.
- **Resolve and bind by OID.** That would require changing statement preparation and `ToSql` compatibility for arbitrary enum values; it is substantially larger than preserving the canonical type expression already available.

### Decision 2: Represent arrays as a dedicated bind kind

Add `BindKind::Array { target: String }` and `PlaceholderTemplate::ArrayCast(String)`. The placeholder renders:

```sql
$N::text[]::<exact target returned by format_type>
```

For the reported column this is:

```sql
$1::text[]::"default$default"."FeatureFlags"[]
```

The binder serializes elements as `Vec<Option<String>>`. `tokio-postgres` therefore binds a real `text[]`, handling escaping, commas, quotes, backslashes, empty strings, and SQL `NULL` elements. PostgreSQL then performs the explicit element-wise cast to the target array type. This works for enum arrays and other scalar arrays without interpolating array contents.

Alternatives considered:

- **Build a `{...}` array literal and cast from text.** Correct escaping is subtle and would recreate behavior already provided by `tokio-postgres`.
- **Expand JSON with `jsonb_array_elements_text` in a SQL subquery.** This makes every placeholder a larger expression, complicates reuse in `WHERE`, and loses the distinction between a JSON null element and the string `"null"` unless handled separately.
- **Bind the JSON string directly to the target array.** `tokio-postgres` cannot serialize `String` as an enum-array OID, and PostgreSQL array input does not accept JSON bracket syntax.

### Decision 3: Normalize array payloads at the backend boundary

The array edit path accepts either:

- a JSON array value sent directly over IPC, or
- a string containing a JSON array, which is what the current grid sends after validation.

For non-JSON target arrays, each top-level element maps as follows: string stays text, number and boolean use their canonical textual representation, JSON `null` becomes a SQL `NULL` array element, and nested arrays/objects return `AppError::Validation`. Precision-sensitive built-in arrays (`bigint`/`int8`, `bigserial`/`serial8`, `numeric`/`decimal`, and `money`) are the exception: their elements must be JSON strings, because parsing them as JavaScript numbers could already have rounded the source lexeme before IPC. For built-in `json[]` and `jsonb[]`, every non-null element is serialized with its complete JSON representation before entering `text[]`; this preserves quotes around JSON string scalars and permits object/array elements. A string that is malformed JSON or parses to a non-array is rejected. An empty JSON array binds as an empty `text[]` and then casts to the declared target.

A whole-column JSON `null` uses `Option::<Vec<Option<String>>>::None` and the same `ArrayCast` placeholder. This preserves the distinction between SQL `NULL`, an empty array, and an array containing `NULL`.

Validation stays in `bind_edit_value`, so malformed values are rejected while SQL is being built and before `postgres_apply_table_edits` opens its transaction. Filter behavior remains unchanged.

### Decision 4: Test both type selection and final SQL rendering

Unit tests in `binding.rs` will assert:

- built-in classification remains case-insensitive;
- a mixed-case quoted scalar custom type preserves its exact cast target;
- quoted mixed-case, lowercase, and schema-qualified array targets select `BindKind::Array` without mutation;
- valid arrays, empty arrays, element `null`, and whole-column `NULL` choose `ArrayCast`;
- malformed JSON, non-array JSON, nested arrays, and object elements fail with the column/type in the message.
- `json[]`/`jsonb[]` string, scalar, object, and array elements remain valid JSON text before the target cast.

Builder tests in `edit.rs` will assert the complete update expression contains `$1::text[]::"default$default"."FeatureFlags"[]` and that PK numbering remains deterministic. These tests catch a regression even if the internal enum shapes later change.

## Risks / Trade-offs

- **[Risk] PostgreSQL does not expose an explicit text-array-to-target-array cast for a particular extension/custom element type.** → The operation returns the normal database cast error and the transaction rolls back; enum and built-in scalar arrays are covered by regression tests and are the supported target set.
- **[Risk] Treating every `format_type` value ending in `[]` as one-dimensional hides declared multidimensional shape.** → PostgreSQL's type name does not encode dimensionality; this change intentionally validates only a one-dimensional JSON payload and documents multidimensional editing as unsupported.
- **[Risk] A non-UI caller currently sends a native `{...}` Postgres literal string.** → The specified edit wire representation is JSON; reject the legacy/implicit shape with a clear validation error instead of maintaining two ambiguous syntaxes.
- **[Risk] Exact catalog text is interpolated into SQL.** → It is not user input: `pg_catalog.format_type` supplies correctly quoted SQL, while values remain bound parameters. Add tests with quotes and special characters to guard this boundary.
- **[Risk] PostgreSQL arrays may use non-default lower bounds, but the editor wire value contains only JSON elements.** → Array edits are whole-value replacements and therefore create a standard one-based array; preserving custom bounds would require a distinct wire contract that carries dimensional metadata and is outside this targeted fix.
- **[Risk] The current JSON wire value cannot distinguish a SQL `NULL` element from a JSON scalar `null` inside `json[]`/`jsonb[]`.** → Retain the existing array-editor convention that unquoted JSON `null` means SQL `NULL`; a future typed wire representation can model both states explicitly.
- **[Trade-off] Array elements are converted through text rather than bound in their native element type.** → This is required for arbitrary enums and domains and delegates final validation to the declared Postgres type; the extra cast cost is negligible for interactive row edits.

## Migration Plan

No data migration or feature flag is required. Ship the backend change with the desktop release. Rollback is the normal application rollback because command signatures and persisted data formats do not change.

## Open Questions

None. The reported enum array is one-dimensional and the existing JSON textarea defines the accepted edit representation.
