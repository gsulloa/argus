## Context

The Postgres table viewer (`postgres-data-grid` capability) currently filters via a per-column popover (`ColumnFilter.tsx`) that edits a flat `Filter[]` joined with `AND` by the Rust backend. The shape limits us to single-column predicates ANDed together — no `OR`, no cross-column search, no escape hatch for SQL the structured form can't express. The user wants the TablePlus filter bar pattern: a top-of-grid bar that exposes every active predicate, supports grouped boolean logic, an "any column" search, an explicit Apply, and a Raw SQL fallback.

The state machinery to wire this is mostly already there: `useTableData` already hands a `filters` array to the Rust command, the Rust side already builds parametrized predicates per operator, column metadata already includes type/nullable so we can filter operators by type. What changes is the **shape** of the filter payload (flat list → recursive tree), the **operator surface** (sugar + list operators), the **filter surface in the UI** (popover → bar with draft/applied), and the **escape hatches** (Any column + Raw WHERE + Open in SQL Editor).

The SQL Editor already accepts a prefilled `sql` string in its `postgres-query` tab payload, so "Open in SQL Editor" is a thin consumer of an existing primitive.

## Goals / Non-Goals

**Goals:**
- Replace the per-column popover with a single, always-visible filter bar at the top of the data grid.
- Support `A AND B AND (C OR D) AND E` — flat AND root with one level of OR groups. No deeper nesting.
- Add an "Any column" pseudo-column that fans out across every text-castable column with text-style operators.
- Add a Raw SQL mode that lets the user type a raw `WHERE` body when the structured form falls short.
- Add an "Open in SQL Editor" button that opens a new query tab with a prefilled `SELECT` reflecting the current draft.
- Preserve the explicit "draft vs applied" boundary: edits to the bar do not re-query until Apply.
- Keep the parametrized-SQL guarantee for the Structured mode. Raw mode is a string-substitution path with explicit user awareness.

**Non-Goals:**
- Persisting filters across app restarts.
- Saved/named filter recipes.
- Nested OR groups beyond one level (`(A OR (B AND C)) OR D`).
- A SQL-aware Raw → Structured parser. Switching from Raw to Structured discards the raw body after a confirm.
- Replacing or merging the existing sort UX into the filter bar.
- Adding "filter by this cell value" right-click gestures (deferred until v1 ships).

## Decisions

### D1: AND root with one OR-group level (Option C)

**Decision:** The filter tree is `{ root: AND, children: Array<Condition | { connector: OR, children: Condition[] }> }`. The root is always `AND`. Each child is either a `Condition` (leaf) or an `OR` group containing condition leaves. No deeper nesting allowed.

**Rationale:** The 95th-percentile SQL filter expression is shaped like `status = 'active' AND (region = 'CL' OR region = 'AR') AND deleted_at IS NULL`. The Option C tree expresses this exactly, with no precedence ambiguity. Users always see explicit groups instead of relying on SQL's `AND > OR` precedence.

**Alternatives considered:**
- *Global toggle (Match all / Match any):* Cheaper UI but cannot express `A AND (B OR C)`. Punts on the request.
- *Per-row connector (TablePlus literal):* Implicit precedence (`A AND B OR C` = `(A AND B) OR C`) is a footgun — users don't see the parens.
- *Arbitrary-depth tree:* More power but the UI to render and edit nested groups is genuinely complex (collapse/expand, drag between groups, etc.). YAGNI for now.

### D2: Replace the per-column popover, do not coexist

**Decision:** Delete `ColumnFilter.tsx` and the funnel icon in `DataGrid` headers. The bar is the only filter surface.

**Rationale:** Two surfaces mean two state owners (or one shared owner with two writes), divergent UX (popover auto-applies, bar is explicit), and a discoverability problem ("which one's active?"). The bar is always visible at the top of the grid — the popover gesture is redundant.

**Alternatives considered:**
- *Keep both, popover writes into the same state:* Possible, but the popover would need to also use draft/applied semantics, or it would silently bypass Apply, and we'd be defending two UIs forever.
- *Header-click as a shortcut to focus a draft row in the bar:* A plausible v1.5 nicety. Skipped for v1 to keep the change tight.

### D3: Backend filter payload — `filter_tree` + optional `raw_where`, mutually exclusive

**Decision:** `postgres_query_table` and `postgres_count_table` accept:

```rust
struct QueryOptions {
    limit: i64,
    offset: i64,
    order_by: Vec<OrderBy>,
    filter_tree: Option<FilterTree>,   // structured mode
    raw_where: Option<String>,         // raw mode
    // ... existing fields
}

enum FilterNode {
    Condition(Condition),
    OrGroup(Vec<Condition>),
}

struct FilterTree {
    children: Vec<FilterNode>,   // joined by AND at root
}

struct Condition {
    column: ColumnRef,           // Named(String) | AnyColumn
    op: Operator,
    value: Option<Value>,        // Some for most ops, None for IS NULL/IS NOT NULL
}
```

Setting both `filter_tree` and `raw_where` is a validation error. Setting neither equals "no WHERE clause".

**Rationale:** Two distinct execution paths (structured = parametrized predicate compilation, raw = string substitution) deserve two distinct payload fields. A single `filter` field with a tagged union would conflate them.

**Alternatives considered:**
- *Tagged union `Filter::Structured(tree) | Filter::Raw(string)`:* Slightly cleaner from a type theory perspective but harder to evolve (the structured tree is going to grow more sub-fields than the raw mode).
- *Keep the legacy flat `filters` field for back-compat:* The change ships in one commit on a feature branch, no consumers in the wild. Dead weight.

### D4: Operator set expansion

**Decision:** Add to the existing operator set:
- `Contains` → `LIKE '%' || $n || '%'`
- `StartsWith` → `LIKE $n || '%'`
- `EndsWith` → `LIKE '%' || $n`
- `In` → `IN ($n, $n+1, ...)` from a list value
- `NotIn` → `NOT IN (...)` from a list value

**Rationale:** All of these are TablePlus-grade conveniences that are pure sugar over `LIKE` and `IN`. Each is a 5-line addition to `predicate_for`. `Contains` is the most-asked-for missing operator.

**Alternatives considered:**
- *Regex match (`~` / `~*`):* Powerful but a footgun (catastrophic backtracking, accidentally turning user input into regex metacharacters). Skip.
- *`ILIKE`-only "Contains":* Drop case-sensitivity entirely. Considered but `LIKE` matches today's behavior; case-insensitive is a checkbox we can add later if asked.

### D5: "Any column" semantics — fan out across text-castable columns

**Decision:** When `column = AnyColumn` in a Condition, the backend expands the predicate into:

```sql
(col1::text [op] $n OR col2::text [op] $n OR ...)
```

…over every column whose `data_type` is castable to text (everything except `bytea` and composite types). The same `$n` parameter is shared across all branches.

Operators allowed for `AnyColumn`:
- `=`, `!=`, `LIKE`, `NOT LIKE`, `Contains`, `StartsWith`, `EndsWith`

Operators rejected (return `AppError::Validation`): `<`, `<=`, `>`, `>=`, `BETWEEN`, `IS NULL`, `IS NOT NULL`, `In`, `NotIn`. The frontend filters the operator dropdown so a rejected combination is unreachable through the UI.

**Rationale:** Casting to `::text` works for numerics, dates, JSON (renders as JSON text), arrays, enums, UUIDs — everything a user types into "search anything". `bytea` and composite types are outliers we can safely skip with a tooltip.

**Trade-off:** This forces a sequential scan on big tables. Surface a `⚠` icon in the UI tooltip: "Searches every text-castable column — slow on large tables."

**Alternatives considered:**
- *Cap at first N columns:* Saves backend pain but changes semantics from what users expect. Skip.
- *Concat all columns and match the concat:* Faster index-buster but loses per-column semantics and weird with NULLs.

### D6: Raw WHERE — CodeMirror inline editor + Switch warnings

**Decision:** A toggle on the bar switches between Structured and Raw modes:

- **Structured → Raw:** Compile the current draft to a SQL `WHERE` body via the TS `compileWhere()` helper and seed the Raw textarea with it. No data loss; the user can refine.
- **Raw → Structured:** Show a confirm dialog ("Switch to structured? Your raw WHERE will be discarded."). On confirm, reset to an empty structured tree.

The Raw editor is a CodeMirror 6 instance configured with the Postgres SQL dialect (same primitives the SQL editor uses), but with no autocomplete/run shortcuts — it's just a typed `WHERE` body. Empty raw body equals "no WHERE clause".

**Rationale:** A SQL-aware parser that maps an arbitrary WHERE expression back to the structured tree is a significant project (handles parens, arbitrary functions, operator precedence). The user-facing value is low — most users either compose structured filters or live in raw. The asymmetric switch (structured → raw is lossless, raw → structured discards) is honest about the asymmetry.

**Trade-off:** Lost productivity if a user types a complex raw WHERE and accidentally toggles back to structured. Mitigation: explicit confirm dialog + Esc cancels.

**Alternatives considered:**
- *Best-effort raw → structured parser:* Fragile, will mis-parse, will produce unstructured frustration. Skip.
- *Warn but allow:* Same outcome since the raw body has no structured equivalent; just let the user accept the loss with a click.

### D7: Draft vs applied state — only `applied` is fetched, only Apply makes draft = applied

**Decision:** The `TableViewerTab` owns two filter values:

```typescript
const [draft, setDraft]     = useState<FilterModel>(initial)
const [applied, setApplied] = useState<FilterModel>(initial)
const isDirty = !deepEqual(draft, applied)
```

`useTableData` reacts to `applied` only. The Apply button (and `Cmd+Enter` / `⌘⏎`) sets `applied` to the current `draft`. `Esc` resets `draft` to `applied`. The bar shows a dirty marker (a small `●` next to "Apply") whenever `isDirty`.

**Rationale:** Auto-applying on every keystroke makes multi-row composition unusable (each edit re-queries). Explicit Apply is the TablePlus norm. Splitting `draft` from `applied` keeps the rendered grid stable while the user composes.

**Alternatives considered:**
- *Debounce auto-apply at 500ms:* Still fires queries the user didn't ask for, and feels laggy on big tables. Skip.
- *Apply on blur:* Surprising side effect on "I clicked elsewhere".

### D8: TS-side WHERE compiler shared with backend

**Decision:** Implement `compileWhere(model: FilterModel): { sql: string, mode: "structured" | "raw" }` on the frontend. Used for:
- The "Open in SQL Editor" button (generates the prefilled `SELECT`).
- A small "preview" line under the bar showing the active SQL (helps users learn the mapping).

The backend keeps its own parametrized compiler (the source of truth for execution).

**Rationale:** Duplicating compile logic is fine because the TS version is for display/copy only — it doesn't need parameter binding (it inlines literals with proper escaping). The two implementations stay in sync via spec scenarios.

**Trade-off:** Two compilers can drift. Mitigation: spec scenarios cover the SQL output for both, and the TS compiler is short (~80 lines).

### D9: "Open in SQL Editor" reuses existing tab payload

**Decision:** The button generates `SELECT * FROM "<schema>"."<relation>" WHERE <where> [ORDER BY ...] LIMIT <current_page_size>` and dispatches the existing tab-open action with payload `{ connectionId, connectionName, sql }`. The current `applied` (not `draft`) is used.

**Rationale:** The SQL editor's spec already accepts a prefilled `sql` string. Zero new infrastructure. Using `applied` matches the user's mental model — "open what I'm currently looking at".

### D10: No filter persistence across app restarts in v1

**Decision:** Filters live in tab state. Closing the tab loses them. Reopening the table starts with an empty filter set.

**Rationale:** Persistence opens scope for "saved filters", per-(conn, schema, table) keying, conflict resolution if the schema changes, and a settings UI. Each is its own decision. Defer until users ask.

## Risks / Trade-offs

- **Raw WHERE injection footgun** → Mitigation: the user is already authenticated to a connection they own. Raw WHERE is no more dangerous than the SQL editor itself. Surface clear validation errors when Postgres rejects the WHERE.
- **Any-column performance on wide / large tables** → Mitigation: tooltip warning on the Any-column option; non-blocking. Future work could cap or surface an "estimated rows scanned" hint.
- **Compiler drift between TS and Rust** → Mitigation: spec scenarios pin the SQL output for representative trees; both implementations are reviewed against the same scenarios.
- **Breaking the `postgres_query_table` payload shape** → Mitigation: the change ships in one PR; no external consumers. Update all call sites in the same change.
- **User confusion when Raw → Structured discards their work** → Mitigation: explicit confirm with a Cancel default. Future work could offer "save current raw to clipboard" before switching.
- **One-level-of-OR-groups limitation surfaces as user pain** → Mitigation: ship and listen. If it bites, upgrading the tree to arbitrary-depth nesting is mechanical (the recursive backend is already shaped for it; only the UI grows).

## Migration Plan

1. **Backend first:** Land the `FilterTree` shape, the new operators, the `raw_where` field, and the Any-column expansion. Validation + tests in Rust.
2. **Frontend wiring:** Update `dataApi.queryTable` / `countTable` to send the new payload (initially with a single AND root and no OR groups, no raw, no any-column — exact same surface as today).
3. **Frontend bar:** Add `FilterBar` and friends, hidden behind the bar UI. Existing per-column popover keeps working.
4. **Cutover:** Flip `TableViewerTab` to use the bar exclusively. Delete `ColumnFilter.tsx` and the funnel UI in `DataGrid`.
5. **Spec sync:** Archive this change; the modified `postgres-data-grid` spec becomes the new source of truth.

There is no rollback strategy beyond `git revert` — this is a self-contained UI change, not a data migration.

## Open Questions

- **Operator label for "Contains" — case-sensitive or case-insensitive by default?** TablePlus uses case-insensitive. Following suit suggests `ILIKE` rather than `LIKE`. Pin in specs as `ILIKE`.
- **Raw WHERE mode — should we strip a leading `WHERE` keyword if the user types it?** Quality-of-life. Likely yes; trim once before substitution. Pin in specs.
- **"Open in SQL Editor" — should we include the active sort?** Following D9 it does. Confirm via spec scenario.
- **Empty rows in an OR group — how do we render?** Probably the group is invisible (group with zero conditions = no-op). Spec covers this in the AND-OR-groups requirement.
