## 1. Normalization core (Rust)

- [x] 1.1 Add the `regex` crate to `src-tauri/Cargo.toml` (or confirm an existing one is usable) and lock it.
- [x] 1.2 Define the `TableMatch` config type in `src-tauri/src/modules/dynamo/params.rs`: simple form `{ prefix?: String, suffix_pattern?: String }` and advanced form `{ regex: String }` (serde-tagged or flattened so JSON round-trips through the opaque `params` column).
- [x] 1.3 Create `src-tauri/src/modules/context/normalize.rs` with `fn normalize(name: &str, rule: Option<&TableMatch>) -> String` implementing: identity when `None`/empty; capture-regex → `logical` group; prefix-strip then suffix-pattern-strip; non-match → return input unchanged.
- [x] 1.4 Add `TableMatch::validate()` (or fold into `DynamoParams::validate()`): reject non-compiling `suffix_pattern`/`regex`, reject advanced-form `regex` without a `logical` capture group, accept absent/empty.
- [x] 1.5 Unit tests for `normalize`: identity, prefix+suffix, capture regex, suffix changes equal, non-match degrades to identity, empty rule.

## 2. Connection params wiring (Rust)

- [x] 2.1 Extend `DynamoParams` (`params.rs`) with `table_match: Option<TableMatch>` (`#[serde(default, skip_serializing_if = "Option::is_none")]`).
- [x] 2.2 Call `TableMatch::validate()` from `DynamoParams::validate()` so create/update rejects malformed rules with `AppError::Validation`.
- [x] 2.3 Add a helper to load the `TableMatch` rule for a connection id from the DB-stored params (reuse the existing params-deserialization path) for use by context commands.
- [x] 2.4 Tests for validation scenarios: valid round-trip, malformed regex rejected, missing `logical` group rejected, absent rule valid.

## 3. Read-path matching (Rust)

- [x] 3.1 In `context_list_models` (`commands.rs:~388`): load the connection's rule, compute `normalize(table, rule)`, and compare against `doc.system.physical_table`.
- [x] 3.2 In `context_get_object` / `identity` matching (`commands.rs:~157,~340`): for Dynamo connections (schema absent) normalize `identity_str` before comparison; leave relational engines untouched.
- [x] 3.3 Tests: CDK-named live table matches logical model docs; same folder reused across two connections with different prefixes; unconfigured connection matches exactly (retrocompat).
- [x] 3.4 Normalize the model **write** path: `context_save_model` / `context_delete_model` fold the live `table` arg before building `dynamo/tables/<logical>/models/<slug>.md`, so the editor + AI extraction write under the logical folder (matching reads). Regression test added.

## 4. Sync write-path + dedup (Rust)

- [x] 4.1 Apply `normalize` when deriving the Dynamo target path in `sync.rs` `target_path_for` (`:57`) / where `shape.name` feeds the path (coordinate with the Dynamo introspector in `introspect_adapters.rs`).
- [x] 4.2 Implement collision handling in the Dynamo sync loop: when two live tables normalize to the same logical name, keep the first, skip the rest, and record each skip in the `SyncReport` (warnings/skipped channel).
- [x] 4.3 Tests: logical filename written under a rule; re-deploy with new suffix updates the same file (human/body preserved); colliding tables skipped with report entry; no rule → unchanged `shape.name` paths.

## 5. Schema-tree badge matching (Rust/TS)

- [x] 5.1 Ensure the documented-object badge resolution for Dynamo (`DynamoConnectionSubtree` leaves) compares the normalized live name — adjust whichever layer (backend list vs. frontend compare) currently does the exact match.
- [x] 5.2 Test/verify: CDK-named leaf shows the `📄` badge via its logical doc; undocumented leaf shows none.

## 6. Frontend connection form (TS)

- [x] 6.1 Extend the Dynamo params TS type (`src/modules/dynamo/...` params/types) with the optional `table_match` shape mirroring the Rust type.
- [x] 6.2 Add optional, collapsed-by-default "Table name matching" fields to the Dynamo connection form: simple (prefix + suffix pattern) with an advanced (regex) toggle; empty = default behavior.
- [x] 6.3 Surface backend validation errors inline on the form (malformed regex / missing `logical` group).

## 7. Docs & verification

- [x] 7.1 Update `README.md` "Context folders" (and `CLAUDE.md` if needed) to document Dynamo logical-name matching and the per-connection rule, including that pre-existing suffix-named files need manual cleanup.
- [x] 7.2 Run `openspec validate dynamo-context-logical-matching`, the Rust test suite, and lint; manually verify dev/staging/prod against one shared folder. _(openspec validate ✓; Rust suite 1156 passed — the only 2 failures are pre-existing, env-only AI keychain tests outside this change; eslint clean on changed files; live dev/staging/prod manual verification requires real AWS + UI and is left to the user.)_
