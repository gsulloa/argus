## Context

`context_list_known_folders` powers the reuse-first flow for linking a connection to an existing context folder. Its backend lives in `packages/app/src-tauri/src/modules/context/commands.rs`:

- `KnownFolderEntry` (≈ lines 366-375): `{ path, name, connection_ids: Vec<String> }`.
- `list_known_folders_inner(db_conn)` (≈ lines 381-426): loads `connections::list()`, filters those with a `context_path`, canonicalizes each path (`std::fs::canonicalize`, silently skipping missing paths), groups connection ids by canonical root (insertion-ordered), parses `context.yaml` per root, and skips roots with a missing/unparseable manifest. `name` comes from `manifest.name`.

The connection records loaded here already carry `name: String` and `kind: String` (`packages/app/src-tauri/src/platform/connections.rs`), and `kind` maps to an engine via `EngineKind::from_connection_kind` (`modules/context/engine.rs`). So the disambiguating data is already in hand at grouping time — it just isn't propagated to the entry.

The TS type `KnownFolder` (`packages/app/src/modules/context/types.ts` ≈ lines 149-157) mirrors the Rust struct. Three UI surfaces render the list:

- `ContextFolderRow.tsx` (≈ 337-353): shows `name` + `path`.
- `dynamo/data-view/LinkFolderPrompt.tsx` (≈ 229-273): shows `name` + `path`.
- `ContextQueriesBranch.tsx` (≈ 862-878): shows **name only**; path is `title=` tooltip only. Worst-affected.

`useContextFolderLink.ts` (≈ 49-65) is the shared hook feeding `ContextQueriesBranch`.

## Goals / Non-Goals

**Goals:**
- Make same-named known folders distinguishable in every reuse-first selector by showing the path and the connections (name + engine) already using each folder.
- Keep the change additive and localized — no DB migration, no `context.yaml` change, no command signature change.

**Non-Goals:**
- Redesigning the link/setup flow or its layout beyond what's needed to display the extra context.
- Changing canonicalization, staleness filtering, or group-independence behavior.
- Deduplicating or renaming folders on disk.

## Decisions

**1. Enrich the backend entry rather than resolve on the client.**
Add a per-connection sub-object to `KnownFolderEntry` — e.g. `connections: Vec<KnownFolderConnection>` with `{ id, name, engine }` — computed inside `list_known_folders_inner` from the already-loaded connection records (`engine` via `EngineKind::from_connection_kind(&kind)`, serialized to its string form). Retain the existing `connection_ids` field for backward compatibility so no consumer breaks.

*Why over client-side resolution:* the frontend `useConnections()` list does a naive `context_path` string compare that misses canonicalization-equivalent paths, whereas the backend already groups by canonical root correctly. Resolving engine/name from the authoritative backend grouping avoids that mismatch and keeps a single source of truth.

*Alternative considered:* resolve `connection_ids` → name/engine against `useConnections()` in each component. Rejected: duplicates logic across three surfaces and reintroduces the canonicalization gap.

**2. Mirror the type and render consistently across all three surfaces.**
Extend `KnownFolder` in `types.ts` with the new `connections` array (additive). Each selector option renders: manifest name, canonical path (visible, not just tooltip), and a compact summary of referencing connections ("used by: <name> · <engine>, …"). `ContextQueriesBranch` gets the biggest change since it currently shows name only.

*Why:* the issue is fundamentally a display gap; the three surfaces should be consistent so the fix isn't partial.

**3. Engine rendering uses existing engine labels.**
Reuse whatever human label the app already uses for engines rather than raw `kind` strings, matching how engines are labelled elsewhere in the UI.

## Risks / Trade-offs

- [A folder is referenced by many connections, making the summary long] → Cap the visible list (e.g. show first N + "+K more") and rely on the path as the primary distinguisher.
- [`connection_ids` still returned alongside the richer `connections` array is redundant] → Accept the minor redundancy to keep the change non-breaking; `connections` supersedes it for display.
- [Engine label lookup for an unknown/legacy `kind`] → Fall back to the raw `kind` string so an unrecognized engine still renders something rather than nothing.

## Open Questions

- None blocking. Whether to eventually drop `connection_ids` in favor of `connections` is a future cleanup, out of scope here.
