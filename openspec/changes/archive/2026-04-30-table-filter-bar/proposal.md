## Why

Today's filter UX is a per-column header popover that only edits one predicate at a time and offers no way to see the full active filter set at a glance. As soon as a user wants to compose more than one or two filters, mix in `OR`, search across all columns, or drop into a raw `WHERE` clause, the popover collapses. TablePlus solves this with a top-of-grid filter bar that exposes every active predicate, supports grouped `AND`/`OR`, an "any column" search, an explicit Apply, and a raw-SQL escape hatch. We want the same in Argus, replacing the per-column popover entirely.

## What Changes

- **BREAKING (UI):** Remove the per-column header filter popover (`ColumnFilter.tsx`). Filtering is now done exclusively from a new top-of-grid filter bar.
- Add a structured filter bar above the data grid with multiple condition rows, an explicit Apply button, and Cmd+Enter / Esc shortcuts. The bar replaces the popover as the only filter surface.
- Support a flat `AND` root with one optional level of `OR` groups (e.g. `A AND B AND (C OR D) AND E`). No deeper nesting in v1.
- Introduce an "Any column" pseudo-column that matches across every text-castable column with text-style operators (Contains, Equals, Starts with, Ends with, Not equals).
- Expand the operator set with text sugar (`Contains`, `Starts with`, `Ends with`) and list operators (`In list`, `Not in list`). Existing `=`, `!=`, comparators, `BETWEEN`, `IS NULL`, `IS NOT NULL`, `LIKE`, `NOT LIKE` remain.
- Add a Raw SQL mode in the bar: a CodeMirror `WHERE` editor that ships its body to the backend as a raw clause string. Switching from Structured → Raw seeds the textarea with the compiled WHERE; switching Raw → Structured prompts before discarding the raw body.
- Add an "Open in SQL Editor" affordance that opens a new `postgres-query` tab pre-populated with `SELECT * FROM "<schema>"."<relation>" WHERE <where> ORDER BY <order> LIMIT <limit>` reflecting the current draft (works in both Structured and Raw modes).
- **BREAKING (API):** `postgres_query_table` and `postgres_count_table` accept a new `filter_tree` payload (recursive AND-root + OR-groups) **instead of** the legacy flat `filters: Vec<Filter>`. They also accept an optional `raw_where: String` mutually exclusive with `filter_tree`.
- Filter state moves to a `draft` vs `applied` model: only `applied` is sent to the backend; the bar shows a dirty marker until Apply is pressed.

## Capabilities

### New Capabilities
_(none — this change extends an existing capability.)_

### Modified Capabilities
- `postgres-data-grid`: replaces the flat-AND `filters` payload with a tree, expands the operator set, adds Any-column and Raw-WHERE support, removes the per-column header filter UI, and adds the filter-bar surface with explicit Apply and "Open in SQL Editor" semantics.

## Impact

**Frontend**
- Remove `src/modules/postgres/data/ColumnFilter.tsx` and the funnel UI in `DataGrid.tsx`'s column headers.
- Add `src/modules/postgres/data/filter-bar/` with `FilterBar`, `ConditionRow`, `OrGroup`, `ColumnPicker`, `ValueInput`, `RawWhereEditor`, and `compileWhere.ts` (a TS WHERE compiler used for previews and "Open in SQL Editor").
- Update `TableViewerTab.tsx` to own `draft`/`applied` filter state and hand `applied` to `useTableData`.
- Update `useTableData.ts` and `dataApi` to send the new payload shape.

**Backend (Rust, `src-tauri/src/modules/postgres/data.rs`)**
- Replace the flat `Vec<Filter>` input on `postgres_query_table` and `postgres_count_table` with the new `FilterTree` shape (recursive AND-root + one OR-group level) and a sibling `raw_where: Option<String>`.
- Extend `predicate_for` with a cast prefix (for Any-column) and the new operators (`Contains`, `StartsWith`, `EndsWith`, `In`, `NotIn`).
- Add `expand_any_column` that fans an Any-column condition out across every text-castable column of the relation (skips `bytea` and composite types).
- Reject combinations that violate validation (e.g. Any-column with a numeric-only operator, both `filter_tree` and `raw_where` set, mismatched `BETWEEN`/`In` payloads) before dispatching SQL.

**Specs**
- `openspec/specs/postgres-data-grid/spec.md` — modified deltas only (see `specs/postgres-data-grid/spec.md` in this change).

**Out of scope (call out)**
- Persisting filters across app restarts or saved/named filter recipes.
- Nested OR groups beyond one level.
- A SQL-aware Raw → Structured parser. Switching from Raw to Structured discards the raw body after a confirm.
- Replacing the existing sort UX or merging sort into the filter bar.
