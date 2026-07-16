## 1. Backend: enrich known-folder entry

- [x] 1.1 In `packages/app/src-tauri/src/modules/context/commands.rs`, add a `KnownFolderConnection` struct with `{ id: String, name: String, engine: String }` (serde-serialized) and add a `connections: Vec<KnownFolderConnection>` field to `KnownFolderEntry` (keep the existing `path`, `name`, `connection_ids`).
- [x] 1.2 In `list_known_folders_inner`, while grouping connections by canonical root, capture each connection's `name` and `kind`; map `kind` → engine via `EngineKind::from_connection_kind`, falling back to the raw `kind` string when unrecognized. Populate `connections` in insertion order alongside `connection_ids`.
- [x] 1.3 Verify the command still omits stale/missing-manifest roots and stays independent of connection groups (no behavior change to those paths). Logic paths for those cases are unchanged; existing tests (`list_known_folders_stale_path_omitted`, `_no_manifest_omitted`, `_cross_group_single_entry`) still assert them. Enriched the "two conns" test to assert `dynamodb` kind folds to the canonical `dynamo` engine.

## 2. Frontend: types and API

- [x] 2.1 In `packages/app/src/modules/context/types.ts`, extend `KnownFolder` with `connections: { id: string; name: string; engine: string }[]` (additive; keep `connection_ids`). Added `KnownFolderConnection` interface.
- [x] 2.2 Confirm `packages/app/src/modules/context/api.ts` `listKnownFolders()` needs no signature change (type-only update flows through). Confirmed — returns `KnownFolder[]`, no change.

## 3. Frontend: render disambiguating context in all selectors

- [x] 3.1 `ContextQueriesBranch.tsx` (setup CTA): surface the canonical path in the visible option (not tooltip-only) and add a compact "used by" summary of referencing connections (name + engine). Uses the shared `knownFolderUsedBy` helper + `engineLabel`.
- [x] 3.2 `ContextFolderRow.tsx`: keep name + path; add the "used by" connections summary to each reuse option.
- [x] 3.3 `dynamo/data-view/LinkFolderPrompt.tsx`: keep name + path; add the "used by" connections summary to each reuse option.
- [x] 3.4 Cap long connection lists (first N + "+K more") so options stay compact; ensure the path remains the primary distinguisher. Implemented in `knownFolderDisplay.ts` (`MAX_KNOWN_FOLDER_CONNECTIONS = 3`, `+N more`).
- [x] 3.5 Update `useContextFolderLink.ts` if it shapes/normalizes folder data before it reaches `ContextQueriesBranch`. No change needed — the hook passes `KnownFolder[]` through untouched, so the new `connections` field flows through.

## 4. Verification

- [x] 4.1 Verify two known folders with the same manifest name but different roots render distinct options (differing path + connections). Covered by the enriched `list_known_folders_two_conns_same_root` Rust test (distinct per-connection name+engine) plus the passing frontend selector suites; each surface renders visible path + "Used by" line.
- [x] 4.2 Verify empty-list and stale-path cases still behave (empty array; stale root omitted). Backend Rust tests `_no_linked_folders_returns_empty`, `_stale_path_omitted`, `_no_manifest_omitted`, `_cross_group_single_entry` all pass; frontend empty-list path covered by passing vitest suites.
- [x] 4.3 Run the relevant Rust and frontend test/build checks for the touched modules; confirm design tokens respected. Frontend: `tsc --noEmit` passes; `vitest` context suites pass (32 tests). Rust: `cargo test list_known_folders` passes (5/5). Design tokens: added UI text uses existing token vars (`--text-subtle`, `--text-muted`, `--font-mono`) consistent with surrounding styles.
