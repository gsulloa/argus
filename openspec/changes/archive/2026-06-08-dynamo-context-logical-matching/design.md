## Context

DynamoDB context-folder matching is exact, case-sensitive string equality applied at four points (all in `src-tauri/src/modules/context/` unless noted):

- `context_list_models` filters models by `doc.system.physical_table == table` (`commands.rs:388`).
- `context_get_object` / the schema-tree `📄` badge resolve by `identity(doc) == identity_str`; for Dynamo `identity` is just `system.name` (`commands.rs:157-162,:340`).
- `context_sync_schema` writes `dynamo/tables/<shape.name>.md`, with `shape.name` being the live AWS table name (`sync.rs:57`, `introspect_adapters.rs` Dynamo introspector).
- `physical_table` of model docs is derived from the parent folder name on load (`parser.rs:426`), never from frontmatter.

The live table name flows from the open table unchanged (`DataViewTab.tsx:363` → `listModels(connectionId, tableName)`). Nothing normalizes between the live AWS name and the folder-derived logical name.

The decisive constraint: **the stack prefix is environment-specific** (`MyApp-dev-` vs `MyApp-prod-`) while **the context folder is shared across environments**. The transform that folds a physical name to a logical name therefore must live *per connection*, not in the shared folder. No regex/glob utility exists in `context/` today.

## Goals / Non-Goals

**Goals:**
- One logical doc set (`dynamo/tables/EventsTable.md`, its `models/`, etc.) matches the real physical table in `dev`/`staging`/`prod` without duplicating files.
- A changing random suffix between deploys does not break the match.
- Schema-sync updates the existing logical file instead of creating a new one per deploy.
- Defined, tested behavior when a normalization rule maps two live tables to the same logical name.
- Exact match continues to work unchanged when no rule is configured.

**Non-Goals:**
- Per-doc `physical_match` glob in frontmatter (Option 1 in the issue) — deferred as a future escape hatch.
- Explicit alias lists (Option 3) — the random suffix makes them stale; rejected.
- Engines other than DynamoDB — relational/CloudWatch matching is untouched.
- Reverse mapping (logical → which physical table); only physical → logical is needed.

## Decisions

### Decision 1: Per-connection normalization (not per-doc glob)

Normalization is a **bidirectional fold** `physical → logical` stored on the connection. It is the only approach that fixes *read* (lookups), *write* (sync filename), and *dedup* (one stable file per logical table) at once, with no manual bootstrap.

- **Alternative — glob `physical_match` in the doc** (`*-EventsTable-*`): elegant and environment-agnostic for *reads*, but a glob is a matcher, not a normalizer — it cannot tell sync which logical filename to write, so a freshly-synced folder still lands `MyApp-prod-EventsTable-XXXX.md`. Rejected as the core mechanism; viable later as an additive escape hatch.
- **Alternative — explicit aliases**: the per-deploy random suffix invalidates the list on every deploy. Rejected.

### Decision 2: Config shape — `prefix` + `suffix_pattern`, with an advanced `regex` form

The rule supports two authoring forms (exactly one set; both empty/absent ⇒ identity):

```
# Simple form
table_match:
  prefix: "MyApp-prod-"          # literal prefix to strip (optional)
  suffix_pattern: "-[A-Z0-9]+$"  # regex tail to strip (optional)

# Advanced form (mutually exclusive with the above)
table_match:
  regex: "^MyApp-prod-(?<logical>.+?)-[A-Z0-9]+$"   # named group "logical"
```

Normalization algorithm `normalize(name, rule) -> logical`:
1. No rule / empty rule → return `name` unchanged (retrocompat identity).
2. `regex` form → match against `name`; on match, return the `logical` named capture group; on no match, return `name` unchanged (fall through to exact match).
3. `prefix`/`suffix` form → strip `prefix` if `name` starts with it, then strip the regex match of `suffix_pattern` anchored at the end; return the residue. A part that doesn't apply is skipped.

Rationale: prefix/suffix is legible for the common CDK case; the capture regex covers the messy real CDK names (`Stack-LogicalIdHASH-RANDOM`, double suffix) without inventing bespoke syntax. "No match → return unchanged" guarantees a misconfigured rule degrades to today's exact-match behavior rather than hiding all docs.

- **Alternative — regex-only**: more powerful but opaque for the simple case. Offering both keeps the floor low and the ceiling high.

### Decision 3: Normalize at the command boundary, keep the folder logical

Folder-derived `physical_table` and table-doc `name` stay **logical** (authored once). Each read command loads the connection's rule (`db: State<DbState>` is already present) and computes `logical = normalize(live_name, rule)` *before* comparison:

```
context_list_models:  doc.system.physical_table == normalize(table, rule)
context_get_object:   identity(doc) == normalize(identity_str, rule)   # Dynamo only
```

Relational engines (`schema` present) bypass normalization entirely. This is the smallest change surface — no change to call signatures, no DB migration; the rule reads off the existing `params` JSON.

### Decision 4: Sync writes the logical filename + dedups collisions

`target_path_for` (and the Dynamo introspector that feeds `shape.name`) apply `normalize` so the file is `dynamo/tables/<logical>.md`. Sync iterates live tables; if two live tables normalize to the same logical name, the **first wins, the rest are skipped with a warning surfaced in `SyncReport`** (mirrors the existing per-file warning channel). On read there is no ambiguity: a lookup starts from exactly one open table → one logical name.

- **Alternative — error the whole sync on collision**: too brittle; a single odd table would block syncing everything. Warn+skip keeps sync useful and visible.

### Decision 5: Regex dependency

Add the `regex` crate (or reuse one already in the tree) behind a small `normalize.rs` helper in `context/`. A malformed pattern is rejected at connection create/update time via `DynamoParams::validate()` → `AppError::Validation`, so it never fails silently at match time.

## Risks / Trade-offs

- **Over-greedy regex maps distinct tables to one logical name** → sync dedup warns + skips; reads are unambiguous (single open table). Documented and tested.
- **Rule on the connection, not the folder, so the folder isn't fully self-describing** → acceptable and in fact required: the prefix is environment-specific, so it cannot live in the shared folder. The folder stays portable; only the per-env prefix differs.
- **Misconfigured rule could hide all docs** → mitigated by "no match → return name unchanged" (degrades to exact match) plus validation of the regex at save time.
- **Performance**: regex compiled per command invocation → compile once per call is negligible at folder scale, but cache/compile-once if profiling shows cost.
- **Frontend form complexity** (two mutually-exclusive forms) → default collapsed/optional; empty = today's behavior, so most users never see it.

## Migration Plan

- Purely additive; no DB migration (config rides existing `params` JSON). Existing connections have no rule → identity → unchanged behavior.
- Rollback: removing the field leaves connections matching exactly as before; no data written that older builds can't ignore (`#[serde(default)]`).
- Users with CDK tables that previously synced suffix-named files can configure a rule, then re-sync; old suffix-named files remain on disk until manually removed (call out in docs).

## Open Questions

- Should a re-sync after enabling a rule **rename/migrate** pre-existing suffix-named files to logical names, or leave cleanup manual? (Lean: manual for v1, document it.)
- Config home: extend `DynamoParams` directly vs. attach to the context-folder link record. (Lean: `DynamoParams`, simplest; revisit if other engines need it.)
- Case sensitivity of `prefix` matching — exact (case-sensitive) to mirror today's behavior, or normalize case? (Lean: case-sensitive.)
