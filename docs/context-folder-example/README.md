# Context folder — example

This folder demonstrates the on-disk format Argus expects for a per-service
context folder. Copy it into your service repo (or create a new folder via
**Create folder…** in the connection editor), then link it to one or more
Argus connections.

## Layout

- `context.yaml` — required. Declares `schema_version: 1` and a human-readable
  `name`. The loader rejects folders without it.
- `README.md` — free-form prose for humans; surfaced to the AI payload.
- `<engine>/` — one subtree per database engine the folder describes.
  Argus filters by the linked connection's `kind`, so a Postgres connection
  only sees `postgres/`.
- `ai/overview.md`, `ai/glossary.md` — optional prose included verbatim in
  the AI payload.
- `.gitignore` — written automatically when Argus creates the folder. Ignores
  `_generated.*` and `.argus-cache/` artifacts.

## Object docs

Each documented relation lives at `<engine>/<schema>/<name>.md` (SQL engines)
or `<engine>/tables/<name>/table.md` (Dynamo) or `<engine>/groups/<name>.md`
(CloudWatch). The frontmatter splits into two blocks:

- `system:` — Argus owns it. **Sync schema** in Argus regenerates this block
  from live introspection. Never edit by hand; your changes are silently
  overwritten on next sync.
- `human:` — you own it. Argus never touches it. Use it for tags, owners, and
  per-column notes that surface in the schema browser.

The Markdown body below the frontmatter is yours too. Argus preserves it
byte-for-byte across syncs.

See `postgres/public/users.md` for a worked example.

## Prefab queries

Inside `<engine>/queries/`, pair a body file with a sibling `.meta.yaml`:

- `top-customers.sql` — the query body, with named placeholders `:name`.
- `top-customers.meta.yaml` — display name, description, declared params
  with types and defaults, tags.

The extension depends on the engine: `.sql` for Postgres, MySQL, MSSQL, and
Athena; `.partiql` for DynamoDB; `.cwlogs` for CloudWatch.

Activate a query from the **Context Queries** branch in the sidebar to open
a tab pre-populated with the body and a parameter strip.

These files can be created, renamed, and deleted from within Argus — use
**Save query** in the SQL editor toolbar or the **+** button in the Saved
Queries panel. You can still hand-write or edit the files directly in your
editor; Argus picks up changes within ~250 ms.
