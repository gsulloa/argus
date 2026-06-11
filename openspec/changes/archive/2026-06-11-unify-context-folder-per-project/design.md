## Context

Each connection stores its own `context_path` (a raw string column on the
`connections` table, see `platform/connections.rs`). The `ContextRegistry`
deduplicates filesystem watchers by canonical path, so two connections that
happen to store the same path already share one watcher and one parsed context.
The on-disk layout segregates engines under the root (`<root>/<engine>/<schema>/
<object>.md`), which lets a single root serve connections of different kinds.

In practice users end up with one folder per connection. The cause is the setup
flow: `context_create_folder` (`commands.rs:219`) returns
`"directory not empty"` for any populated directory, so once the first
connection scaffolds `~/proj/` the next connection cannot "create" there and is
pushed to a new path. The `context_link_folder` path (`commands.rs:267`) works on
an already-scaffolded folder, but it is not the obvious default, and there is no
way to *discover* which roots already exist to reuse one.

Established in exploration (`/opsx:explore`): a "project" does **not** map 1:1 to
a `connection-groups` group, and a connection must keep its context regardless of
group membership. Therefore the folder must stay referenced per connection — not
owned by a group. The guiding model is **"the context folder is the project"**:
the project is the set of connections pointing at the same canonical root, and
the project name lives in the root's `context.yaml`.

## Goals / Non-Goals

**Goals:**
- Make pointing multiple connections at one shared root the path of least
  resistance, so "one folder per project" is the natural outcome.
- Make `context_create_folder` idempotent over an existing valid context folder.
- Provide a discovery command so the UI can offer reuse of known folders.
- Keep a connection's context independent of any group it belongs to.

**Non-Goals:**
- No change to the on-disk layout. The `<engine>/<schema>/` nesting stays; we are
  not flattening engine or schema levels.
- No new "project" or folder entity, and no new database column. `context_path`
  stays on the connection.
- No coupling of context folders to `connection-groups`.
- No automatic migration of users who already created multiple folders (nobody
  depends on the current flow yet; existing folders keep working as-is).

## Decisions

### Decision: Keep `context_path` on the connection; do not introduce a folder entity or couple to groups

A project spans connections that are not necessarily in the same group, and a
connection must retain its context when removed from a group. Both constraints
are already satisfied by the existing per-connection `context_path` plus
canonical-path deduplication in `ContextRegistry`. Adding a `context_folders`
table or moving the path onto the group would either re-introduce group coupling
or add a migration for zero behavioral gain.

*Alternatives considered:* (a) Move `context_path` onto the group — rejected:
project ≠ group, and it would strip context on group removal. (b) First-class
`context_folders { id, name, root_path }` table referenced by connections —
rejected as over-engineering: the folder's identity and name already live on
disk in `context.yaml`, and sharing already works by canonical path. The win is
discoverability + flow, not the data model.

### Decision: Make `context_create_folder` create-or-link (idempotent)

Replace the blanket non-empty guard with: if the directory is missing → scaffold
as today; if it exists and `parse_manifest` succeeds → treat as an existing
context folder, do not rewrite scaffold files, return its canonical path; if it
exists, is non-empty, and `parse_manifest` fails → keep returning the validation
error. This lets the 2nd/3rd connection of a project land in the same root
without the user having to know the create-vs-link distinction. Subscription in
the registry continues to be driven by `context_link_folder` / connection load;
`context_create_folder` remains responsible only for ensuring the folder exists
and is valid.

*Alternative considered:* leave `context_create_folder` strict and rely solely on
a better "link existing" UI. Rejected: the error is a real dead-end users hit,
and idempotency is cheap and intuitive.

### Decision: Derive "known folders" from existing connections, not a persisted list

`context_list_known_folders` reads the distinct non-null `context_path` values
across saved connections (via `platform/connections.rs`), canonicalizes each,
collapses duplicates, parses each manifest for the display name, attaches the
linked connection ids, and drops paths that no longer exist or fail to parse.
This needs no new storage and is always consistent with reality.

*Alternative considered:* persist a separate "recent folders" list. Rejected:
extra state to keep in sync, and it could surface folders no connection uses.

## Risks / Trade-offs

- **[Name collisions across engines in one root]** Two engines could each have an
  object named `events`. → Already mitigated by the engine subtree
  (`<root>/postgres/...` vs `<root>/dynamo/...`); this change does not touch the
  layout, so no new collision surface.
- **[Idempotent create silently reusing the wrong folder]** A user could point at
  an unrelated existing context folder. → Acceptable: it is a valid folder by
  definition, the manifest name is shown in the picker, and nothing is
  overwritten. The foreign-non-context-folder case still errors.
- **[Canonicalization differences]** Symlinks / case-insensitive filesystems could
  make two strings resolve to one root. → Use `std::fs::canonicalize` (already
  used by `context_create_folder`) consistently in the discovery command so the
  dedupe key matches the registry's keying.
- **[Stale paths]** A folder may have been moved/deleted. → The discovery command
  omits non-existent / unparseable roots rather than returning broken entries.
