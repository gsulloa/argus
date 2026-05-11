## Context

The Postgres edit path uses a type-aware bind strategy (introduced by `fix-edit-type-aware-binding`) where each column's `BindKind` decides how a JSON value is coerced before being handed to `tokio_postgres`. For `BindKind::Json` and `BindKind::Jsonb`, the current implementation in `src-tauri/src/modules/postgres/binding.rs:350-353` is the bare-minimum form:

```rust
BindKind::Json | BindKind::Jsonb => Ok(BoundParam {
    value: Box::new(v.clone()),
    placeholder: PlaceholderTemplate::Plain,
}),
```

`tokio_postgres::types::ToSql for serde_json::Value` knows how to serialize every JSON variant into a jsonb payload. That works correctly for `Value::Object`, `Value::Array`, `Value::Number`, `Value::Bool`, and `Value::Null`. It works **mechanically** but **semantically wrongly** for `Value::String`: a `Value::String("{\"a\":1}")` is sent as a jsonb scalar with the JSON text `"{\"a\":1}"` — a string, not the parsed object.

The frontend's `EditableCell.tsx` (and `Inspector.tsx`) emits exactly this shape today. `validateJsonInput(text)` returns `result.canonical = JSON.stringify(parsed)` and the commit handler calls `onCommit(result.canonical)`. By the time the value reaches the Tauri command, it is a JSON-serialized `String`. The reproducer in the bug report (`market.product_source_info.metadata`) confirms this is the path users hit.

The fix lives in the backend bind step, not the frontend, because:

- The backend is the last place that knows the column's declared type. Frontend logic depends on `data_type` strings flowing all the way down; trusting any caller (SQL editor, bulk import, future MCP tool, codex agent running raw Tauri commands) to send pre-parsed JSON is brittle.
- The fix is byte-for-byte idempotent: if the frontend already sends `Value::Object`, the new code path doesn't touch it. So it composes cleanly with `fix-json-edit-smart-quote-corruption` and any later refactor that sends typed JSON over the wire.

## Goals / Non-Goals

**Goals:**

- A JSON-encoded string targeting a `json` or `jsonb` column gets parsed and stored as the intended JSON value.
- Unparseable strings produce an `AppError::Validation` naming the column and the parse error — the row is never written with garbage.
- The fix is local to `binding.rs`; no SQL builder, command, or wire-protocol changes.
- The behavior is correct for both the edit path (`bind_edit_value`) and any filter path (`bind_filter_value`) that targets a json column today or in the future.

**Non-Goals:**

- Changing the frontend canonicalization. `EditableCell` and `Inspector` can keep emitting canonical JSON text; the backend now handles that shape.
- Validating jsonb content beyond "is this parseable JSON" (e.g. schema validation, smart-quote rejection — out of scope).
- Touching the `Plain` vs `Cast` placeholder template. `serde_json::Value` binds natively to jsonb; no cast is needed.
- Renaming or restructuring `bind_scalar` / `bind_edit_value`. The diff should be minimal.

## Decisions

### Decision 1: Re-parse `Value::String` for json/jsonb columns inside `bind_scalar`

When `kind ∈ {Json, Jsonb}` and `v` is `Value::String(s)`, do `serde_json::from_str::<JsonValue>(&s)`:

- **On success**: bind the parsed value (`Box::new(parsed)`). The placeholder stays `Plain`.
- **On failure**: return `AppError::Validation(format!("invalid JSON for column '{column}': {err}"))`.

For every other `Value` variant in the json/jsonb arm (`Number`, `Bool`, and — via `bind_edit_value`'s pre-pass — `Object`/`Array`), continue to box `v.clone()` directly. `Null` is handled by `bind_edit_value`'s null-pass (typed `Option::<JsonValue>::None`) and never reaches `bind_scalar`.

**Why parse inside `bind_scalar` (shared) rather than only inside `bind_edit_value`?**
`bind_filter_value` also delegates to `bind_scalar` and forbids only `Null`/`Array`/`Object`. A future structured-filter clause like `WHERE metadata @> $1` against a jsonb column would benefit from the same normalization. Centralizing keeps both call sites honest.

**Alternatives considered:**

- *Wrap on the frontend by sending parsed JSON.* Possible, but doesn't protect non-UI callers; the backend would still need a defensive parse for anything that bypasses the editor.
- *Reject all `Value::String` for jsonb.* Too strict — a legitimate `Value::String("\"hello\"")` payload (quoted JSON string scalar) is valid and should round-trip to a jsonb string scalar.
- *Try to parse, fall back to binding as string on failure.* That preserves the bug for any caller that types unquoted text like `hello`. The user's stated requirement ("Asegurate bien que sea un json antes de guardar, no guardes strings ahi") is explicit: invalid JSON must NOT silently end up in the column.
- *Add a `Cast("jsonb")` placeholder so Postgres parses the text.* Works for the object case but doesn't reject `hello` — Postgres would accept `\"hello\"` and reject `hello` with a server-side error far from the column-name context. Backend `from_str` keeps the validation error close to the bind site and lets us name the column.

### Decision 2: Bind the parsed `JsonValue`, keep placeholder `Plain`

`tokio_postgres` binds `serde_json::Value` directly to jsonb. Adding `::jsonb` to the placeholder buys nothing here (and would force the bound type back to `String`, complicating the bind). Confirmed by the existing `bind_edit_value_jsonb_object_binds_native` unit test that asserts `Plain`.

### Decision 3: Validation error message format

`invalid JSON for column 'metadata': expected value at line 1 column 7` — start with the column name (callers grep activity logs by column), then the column-relative `serde_json::Error` description. The exact wording is a minor concern; the load-bearing part is including both the column name and the parse error.

### Decision 4: Tests live next to the function

Add unit tests in `binding.rs`'s `#[cfg(test)] mod tests` for the matrix in `proposal.md`. Add a regression test in `edit.rs` (`build_update_jsonb_string_input_normalized_to_object`) that exercises the whole builder path: input is a `changes: { metadata: "{\"a\":1}" }` payload (string), and the assertion is that `params[0]`'s `Any::downcast_ref::<serde_json::Value>()` yields `Some(&Value::Object(...))`, NOT `Some(&Value::String(...))`.

## Risks / Trade-offs

- **Risk**: A user wants to store the literal three-character string `"ok"` (with no surrounding quotes typed) as a jsonb string scalar. → They must type `"\"ok\""` (or just `"ok"` if the editor adds quotes). Mitigation: the validation error message includes the parse error, which makes the fix obvious. The frontend's `validateJsonInput` (smart-quote change) already accepts and canonicalizes `"ok"` as a valid JSON string, so the frontend path is already correct; this risk only applies to direct Tauri command callers.
- **Risk**: A column whose `data_type` is `json` (text-encoded) and not `jsonb` may behave subtly differently in tokio-postgres' `ToSql for Value`. → Both `Json` and `Jsonb` share the same Rust binding path; the fix treats them identically. Existing tests cover `Jsonb`; we'll add the same coverage for `Json`.
- **Trade-off**: We're doing an extra parse on every jsonb bind. → Negligible (`serde_json::from_str` on a string we already have in memory) and only runs once per bound param. No perf regression of note.
- **Risk**: This change interleaves with `fix-edit-type-aware-binding` (still in progress) and `fix-json-edit-smart-quote-corruption`. → All three touch `binding.rs` or its consumers, but the diffs do not overlap: type-aware-binding owns placeholder shape, smart-quote owns the frontend validator, this change owns the `String → JSON` normalization inside the `Json|Jsonb` arm. Tasks call out the merge order: this change rebases on top of `fix-edit-type-aware-binding`.

## Migration Plan

No data migration. Existing rows that already contain jsonb-string-scalar garbage in production (the user's `market.product_source_info.metadata` rows from the reproducer) are the user's responsibility to clean up — a one-off `UPDATE … SET metadata = (metadata #>> '{}')::jsonb WHERE jsonb_typeof(metadata) = 'string'` is sufficient and is **out of scope** for this change. We can mention it in the PR body as a hand-off.
