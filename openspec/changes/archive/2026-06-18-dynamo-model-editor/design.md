## Context

`dynamo-filter-by-model` (archived) established the read side of `dynamo_model` docs:

- The doc format — `system: { kind: dynamo_model, name, access_patterns: [{ name?, index, pk, sk? }] }` — and its typed Rust model (`AccessPattern`, `ObjectSystem.access_patterns`/`physical_table` in `context/types.rs:23-66`).
- The parser walks `dynamo/tables/<table>/models/*.md` and derives `physical_table` from the parent directory (`parser.rs`), never from frontmatter (D7-bis).
- `context_list_models(table)` exposes models to the UI (`commands.rs`); the data-view loads them via `useTableModels` and the QueryBuilder offers "By model" mode compiled by `modelCompiler.ts`.

What is missing is the **write side**. The only existing writer is `context_sync_schema`, which calls `execute_sync` → per-file `atomic_write` (`sync.rs:231-240`) and `rewrite_file` (`sync.rs:338-437`), the latter splicing a fresh `system:` block into a file while preserving the `human:` block and body byte-for-byte (including CRLF detection). That machinery is exactly what writing a single model doc needs; this change exposes it for a caller-supplied model rather than an introspected schema.

This change adds: a `ModelDraft` contract, two write commands, a validation gate (reusing `modelCompiler`), and an editor UI.

## Goals / Non-Goals

**Goals:**
- Let a user create, edit, and delete `dynamo_model` docs from the data-view, without hand-editing YAML.
- Validate a draft against the live `TableDescription` before writing, surfacing the same errors the QueryBuilder would (unknown index, bad key type, malformed template).
- Reuse the existing atomic-write + `human:`/body-preserving machinery so a hand-edited body survives an edit through the form.
- Define `ModelDraft` so the AI inspector (separate change) can write through the identical path.

**Non-Goals:**
- AI repo-inspection / draft generation (separate change).
- Editing non-Dynamo context docs, or a general context-folder management view.
- Renaming a model in place as a first-class "rename" operation beyond delete-old + write-new (see D5).
- Schema-sync of models, CloudWatch.

## Decisions

### D1. `ModelDraft` is the single write contract

```
ModelDraft {
  name: string
  access_patterns: AccessPattern[]   // { name?, index, pk, sk? } — same shape the parser reads
  body?: string                       // Markdown, becomes the doc body below the frontmatter
}
```

`physical_table` is **not** part of the draft — the caller passes the target table separately (`context_save_model(connection_id, table, draft)`), and the write path derives the on-disk location from it. This keeps D7-bis intact: the table is encoded by location, never by frontmatter, so a draft can never disagree with where it lands.

- **Why:** one shape for both producers (form now, AI inspector later) means one validation path and one write command. Omitting `physical_table` from the draft makes "draft disagrees with its directory" unrepresentable.

### D2. Write reuses `sync.rs` atomic-write + splice, not a new writer

`context_save_model` resolves the path `<root>/dynamo/tables/<table>/models/<Model>.md`, builds the `system:` block from the draft (`kind: dynamo_model`, `name`, `access_patterns`; **no** `physical_table` — it is derived on read, not written), and:
- if the file exists → `rewrite_file`-style splice: replace `system:`, preserve the existing `human:` block and body byte-for-byte; if the draft carries a `body`, it is only applied when the file is new (an edit never clobbers a hand-written body unless the user explicitly changed it in the form).
- if the file is new → write a fresh doc (`system:` + the draft `body`, or an empty body).

- **Why:** the splice algorithm is already correct and tested for the sync path; a model doc is just a `system:` block plus body. Reusing it guarantees the body-preservation guarantee the base change documented.
- **Open:** whether to factor a shared `write_object_doc(path, system, body_policy)` helper out of `rewrite_file`, or call `rewrite_file` with a single-doc shape. Resolve during implementation — prefer the smallest extraction that keeps one splice implementation.

### D3. Validation gate is `modelCompiler`, best-effort against live schema

Before `context_save_model` is called, the editor runs `modelCompiler.compileModel` for every access pattern against the open table's `TableDescription`:
- **Have `TableDescription`** → full validation: index exists, resolved PK/SK attribute names exist, key typing per D5/D5-bis (numeric keys typed `N`, `begins_with` degrade only on `S`), templates parse per D9. Any error blocks save and is shown inline on the offending pattern.
- **No `TableDescription`** (table unreachable / offline) → grammar-only validation (D9): templates must parse; index/typing unchecked. Save is allowed with a visible "schema checks skipped — table not reachable" warning.

The backend performs the same minimal well-formedness check it already does on read (warn on unterminated `${`); it does **not** duplicate the full compiler. The front-end compiler stays the single authoritative validator (D9 from the base change).

- **Why:** the user can be editing docs while the table is down; a hard requirement on live schema would block legitimate offline authoring. The compiler is already the QueryBuilder's gate — reusing it means "saves validate identically to how queries validate."

### D4. Editor entry point lives on the "By model" selector, as a panel/dialog

The model docs are consumed in the QueryBuilder "By model" mode; that selector is where the user feels the gap ("the entity I want isn't here"). The editor opens from a "＋ New model" / "Edit" affordance adjacent to the entity selector, as a docked panel or dialog over the data-view — **not** a separate top-level view.

- **Why:** tight loop — define an entity and immediately query by it. A separate context-folder management surface is a larger, cross-engine feature out of scope here.
- **Alternative considered:** a dedicated context-folder editor view. Deferred — model docs are the only writable doc kind this change targets; a general editor is its own change.

### D5. Rename = delete-old + write-new; filename from a slug of `name`

The on-disk filename derives from the entity `name` via a slug (`Order` → `Order.md`; non-`[A-Za-z0-9_-]` collapsed/stripped, validated non-empty and unique within the table's `models/` dir). Editing a model's `name` is implemented as: write the new file, then delete the old one (the editor knows the prior name). A bare frontmatter `name` change without a file rename would leave the doc discoverable only by content, so the file must track the name.

- **Why:** `context_list_models` keys entities by `name`; the file should match so the listing and disk agree. Treating rename as delete+write keeps the write command simple (no in-place move semantics) and is observable/reversible.
- **Open:** collision handling when two distinct entities slug to the same filename — reject at save with a clear message naming the conflict.

### D6. Watcher coordination — optimistic update, reconcile on watch event

Writing fires the folder watcher, which re-fetches models via `context_list_models`. The editor applies an optimistic update (the saved model appears immediately) and reconciles when the watch-driven refetch lands, so the UI does not flicker or momentarily lose the just-saved entity.

- **Why:** the watcher and the explicit save are two paths to the same state; without reconciliation the user sees a save → disappear → reappear flash.

## Risks / Trade-offs

- **An edit through the form could clobber a hand-written Markdown body.** Mitigation: the splice (D2) preserves the body byte-for-byte; the form's body field is seeded from the existing body, so "no change in the field" → "no change on disk."
- **Slug collisions** (two entities → same filename). Mitigation: reject at save (D5) with a message naming the conflict.
- **Offline authoring writes a draft that won't compile against the real schema.** Mitigation: the skipped-schema-check warning (D3) is explicit; the doc is inert until the table is reachable, at which point the QueryBuilder surfaces the same compiler error.
- **Connection has no linked context folder.** The editor requires a folder; if none is linked it prompts to link/create one first (reusing the existing link flow) rather than failing silently.

## Migration Plan

Additive only. New commands; no change to the doc format or parser. Existing hand-authored model docs are editable through the form (they parse, the form seeds from them) and unchanged on disk until saved. Rollback = revert the code; docs written by the editor are ordinary `dynamo_model` docs that older builds read fine.

## Open Questions

- Factor a shared `write_object_doc` helper vs reuse `rewrite_file` directly (D2) — resolve in implementation.
- Should delete move the file to a trash/undo buffer, or hard-delete? Default: hard-delete with a confirm, since the doc is plain text under the user's version control.
