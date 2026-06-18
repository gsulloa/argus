## Why

Argus today knows the *shape* of a dataset (schemas, tables, columns introspected live from the source) but nothing about its *meaning*: which columns are PII, which tables are soft-deleted, what the domain glossary is, or which canonical queries the team relies on. That knowledge lives in tribal memory or Notion pages disconnected from the tool where queries are written. Saved-queries help, but they live in Argus's local sqlite — invisible to teammates, lost on machine wipe, not versioned with the service repo they describe.

A connection should be able to point at a **context folder** on disk — a structured, source-agnostic directory of documentation and prefab queries that lives in the service's git repo, is shared across related connections (prod + staging), and is consumable by both the UI and an AI assistant.

## What Changes

- Add a `context_path` field on `connections` (nullable, absolute path) so each connection can optionally link to a folder on disk.
- Define a file-system format for context folders: per-engine subtrees (`postgres/`, `dynamo/`, `cloudwatch/`, …), object docs as Markdown with split `system:` / `human:` frontmatter, prefab queries as `.sql` + sibling `.meta.yaml`, and free-form `ai/` prose.
- Introduce a backend `ContextRegistry` that loads, parses, and watches each unique canonical path once and fans events out to all subscribed connections (so prod + staging sharing a folder cost one watcher, not two).
- Add a "Sync schema → context" command that regenerates the `system:` portion of frontmatter from live introspection without ever touching the `human:` portion or the Markdown body. Tables removed from the source are flagged `deleted_in_db: true`, never deleted from disk.
- Surface context in the UI: object docs **inline** in the schema tree (badge `📄` on tables that have docs, panel on selection), and prefab queries as a **separate** sidebar branch ("Context Queries") distinct from personal Saved Queries.
- Expose the parsed context to the AI query-generation flow as a structured payload.
- Add commands "Create context folder…" (writes skeleton: `context.yaml`, `README.md`, `.gitignore`) and "Link existing folder…" (pick path, validate, attach).

## Capabilities

### New Capabilities

- `connection-context-folders`: Linking connections to on-disk context folders, the folder format (layout, frontmatter, query meta), the registry/watcher that loads and broadcasts changes, schema-sync semantics (frontmatter regen without body loss), and the AI-context export.
- `context-objects-browser`: Inline rendering of object docs in the per-engine schema tree (`📄` badge, side panel, navigation from schema node to doc).
- `context-queries-runner`: Separate sidebar branch for prefab `.sql` + `.meta.yaml` queries, parameter prompting, and execution against the owning connection.

### Modified Capabilities

- `connection-registry`: `connections` row gains a nullable `context_path` field; create/update/list commands accept and return it; deleting a connection does not touch the folder on disk.
- `postgres-schema-browser`, `mysql-schema-browser`, `mssql-schema-browser`, `dynamo-table-browser`: Tree nodes that match an object documented in the linked context folder render a `📄` badge and, on selection, surface the doc panel via `context-objects-browser`.

## Impact

- **Backend (Rust)**: New module `src-tauri/src/modules/context/` (registry, watcher via `notify`, parsers for `context.yaml` / object frontmatter / query meta, schema-sync executor per engine). New migration adding `connections.context_path TEXT`. New Tauri commands: `context_create_folder`, `context_link_folder`, `context_unlink`, `context_list_objects`, `context_get_object`, `context_list_queries`, `context_get_query`, `context_sync_schema`, `context_ai_payload`. New event `context://changed` (path-scoped).
- **Frontend (TS)**: New module `src/modules/context/` (api, hooks, object panel, query list, sync command). Settings UI for connection form ("Context folder" picker with Create / Link / Unlink). Sidebar integration in each engine's schema browser. Wiring into the existing AI query-generation entry point.
- **Storage**: Schema migration `0005_connection_context.sql`. Context payload itself lives on the user's disk, **not** in Argus's sqlite.
- **Dependencies**: Add `notify` (filesystem watch) and `serde_yaml` (frontmatter / meta parsing) to `src-tauri/Cargo.toml`.
- **Coexistence**: `saved-queries` (sqlite, personal) remains untouched. Context queries are a separate concept surfaced separately.
- **Out of scope (v1)**: Path variables / portable paths across machines, conflict resolution for concurrent edits, importing existing Bruno/dbdocs/Schemaspy formats, write-back from UI edits to the folder (folder is read-mostly; only schema-sync writes).
