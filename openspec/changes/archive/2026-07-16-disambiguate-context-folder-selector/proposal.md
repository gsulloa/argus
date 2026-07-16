## Why

When linking a connection that has no context folder yet, the setup flow offers already-known folders first (reuse-first). Today those options are identified by little more than the folder's display **name**, so when several known folders share the same name (e.g. multiple projects/environments each with a `context/` folder named the same in `context.yaml`) they become indistinguishable and the user cannot tell which one to pick. (Reported via in-app feedback, GitHub issue #256.)

## What Changes

- Enrich the `context_list_known_folders` command result so each known-folder entry carries enough to disambiguate visually: the canonical **path** (already present) plus, for each connection currently linked to that root, its **display name** and **engine/kind** (not just the opaque `connection_id`). The backend already loads these connection records when grouping, so this is a localized enrichment.
- Update every reuse-first selector surface to render disambiguating context on each option — the absolute path (or a distinctive fragment) **and** the list of connections (name + engine) already using that folder:
  - `ContextFolderRow` (connection editor row) — already shows name + path; add the referencing-connections summary.
  - `LinkFolderPrompt` (Dynamo model-editor link dialog) — already shows name + path; add the referencing-connections summary.
  - `ContextQueriesBranch` (Context Queries tree setup CTA) — currently shows **name only** (path is tooltip-only); surface the path and referencing connections in the visible UI. This is the worst-affected surface.
- Extend the `KnownFolder` TS type to mirror the enriched backend contract.

No breaking changes: the `path`/`name`/`connection_ids` fields are retained; new per-connection metadata is additive.

## Capabilities

### New Capabilities
<!-- None. -->

### Modified Capabilities
- `connection-context-folders`: the "Known context folders are discoverable for reuse" requirement changes so each returned entry SHALL additionally include, per linked connection, its display name and engine/kind, and the reuse-first selector UI SHALL display the path and referencing connections so same-named folders are distinguishable.

## Impact

- **Rust backend**: `packages/app/src-tauri/src/modules/context/commands.rs` — `KnownFolderEntry` struct and `list_known_folders_inner` (enrich per-connection metadata using the already-loaded connection records; map `kind` → engine via `EngineKind::from_connection_kind`).
- **Frontend types/API**: `packages/app/src/modules/context/types.ts` (`KnownFolder`), `packages/app/src/modules/context/api.ts` (no signature change; type only).
- **Frontend UI**: `ContextFolderRow.tsx`, `dynamo/data-view/LinkFolderPrompt.tsx`, `ContextQueriesBranch.tsx`, and the shared `useContextFolderLink` hook.
- **Spec**: `openspec/specs/connection-context-folders/spec.md`.
- No DB migration; no change to persisted `context.yaml` or `connections` schema.
