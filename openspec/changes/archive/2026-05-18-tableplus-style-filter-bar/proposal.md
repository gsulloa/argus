## Why

The current Argus filter bar is always visible, takes vertical space even when unused, and exposes an expressiveness ceiling (nested OR groups, Raw SQL mode, ⎋ Reset) that few users reach for. TablePlus's filter bar is the industry reference for "fast, keyboard-driven, flat row filtering": hidden by default, surfaced with `⌘F`, one row per condition, per-row checkbox for inclusion, per-row green "Applied" badge, and a single `Apply All` button whose chevron toggles AND vs OR globally. Trading the lost power features for that exact ergonomics is a net usability win and aligns the data viewer with the mental model Postgres power users already have.

## What Changes

- **BREAKING** Filter bar is **hidden by default** (no vertical space taken). A new filter toggle button in the table tab's chrome (next to the subtab header) and the existing `⌘F` shortcut **show/hide** the bar (no longer "focus only"). The previous chevron-collapse control is removed.
- **BREAKING** Remove **Raw SQL mode**. The Mode toggle (Structured / Raw SQL) is deleted. Existing persisted `FilterModel`s with `mode: "raw"` MUST be migrated to an empty Structured model on first read (raw body discarded). The `RawWhereEditor` component and the Raw-related backend path (`raw_where`) remain on the wire for the SQL Editor path but are no longer reachable from the filter bar UI.
- **BREAKING** Remove **OR groups (nested)**. The filter tree becomes a flat list of `condition` children — `or_group` is removed from the `FilterNode` union on the frontend. The single root combinator (`AND` / `OR`) governs how all rows are joined. Persisted trees containing `or_group` children are migrated to an empty tree on first read.
- **BREAKING** Remove the **per-condition `×` (remove) button**, the **`+ AND row`** and **`+ OR group`** add buttons, and the inline **`AND | OR` root toggle**. Replace with TablePlus-style per-row `+ / −` icon buttons at the right of each row and a chevron menu on the `Apply All` button for AND/OR.
- **BREAKING** Remove the **`Reset` button** and the **`Esc` discard-draft** shortcut. Replace with a footer-level **`Unset`** button that clears all draft rows in one click.
- Add a **checkbox at the left of each filter row** ("include in Apply All"). New rows default to **checked**. Unchecked rows are excluded from `Apply All` but can still be applied individually via their per-row `Apply` button.
- Add a **green `Applied` badge** state on the per-row Apply button (and a green tint on the row's value input) whenever that exact row is part of the currently `applied` filter set. Editing any field of an applied row MUST flip the badge back to `Apply` (gray) until re-applied.
- The per-row `Apply` button continues to behave as "apply only this row, replacing the active filter set" (current `onApplyOnlyRow` semantics, just exposed on every row).
- Add an **`Apply All` button** at the bottom-right of the filter bar. Activating `Apply All` MUST set `applied` to the tree formed by **only the checked draft rows**, joined by the persistent root combinator (AND default, OR optional). A chevron next to `Apply All` opens a menu with two items: **`Apply All Checked Filters with AND – Default` (`⌘↵`)** and **`Apply All Checked Filters with OR` (`⇧⌘↵`)**. The menu choice updates `draft.tree.combinator` persistently (survives between Applies); the button label stays `Apply All` (the active combinator is reflected only by which menu item is checkmarked).
- Add a **footer shortcut hint strip** with the labels: `Show: ⌘F`, `Insert: ⌘I`, `Remove: ⌘⇧I`, `Apply All: ⌘↵`, `Up: ⌘↑`, `Down: ⌘↓`, `Columns: ⌘←`, and the `Operator: [Unset]` button.
- Add keyboard shortcuts scoped to the filter bar: `⌘I` inserts a new empty row below the focused row (or at the end if no row focused); `⌘⇧I` removes the focused row; `⌘↑` / `⌘↓` move focus between rows (no row reordering); `⌘←` opens the column picker dropdown of the focused row; `⇧⌘↵` performs Apply All with OR.
- Add **footer placeholder buttons** `Export` and `SQL` (visual parity with TablePlus). `SQL` MUST open the SQL Editor with the compiled WHERE prefilled (current `Open in SQL Editor` behavior). `Export` MUST render as a **disabled placeholder** for this change (a follow-up will implement CSV/JSON export).
- Persist the **filter bar visibility** state (hidden by default) and the **root combinator choice** in the existing per-table viewer settings; preserve `draft` across hide/show toggles within a tab session.
- "Any column" pseudo-column **remains** in the column picker, but the inline ⚠ performance-warning icon is **removed** (visual parity with TablePlus, which has no such warning).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `postgres-data-grid`: The "Filter bar surface" requirement (visibility, `⌘F` semantics, action layout), the "Filter draft and applied state" requirement (Reset/Esc removal, per-row Apply / Apply All split, checkbox-gated `applied` set, applied-row visual state), the "AND root with OR groups" requirement (OR groups removed, `or_group` removed from `FilterNode`, persistent root combinator surfaced via Apply All chevron), the "Any column search" requirement (warning icon removed), and the "Raw WHERE mode" requirement (removed from the filter bar — Raw stays in the backend for `Open in SQL Editor` but is no longer a user-selectable mode). New filter-bar keyboard shortcuts (`⌘I`, `⌘⇧I`, `⌘↑`, `⌘↓`, `⌘←`, `⇧⌘↵`) are added.

## Impact

**Frontend (React/TS)**

- `src/modules/postgres/data/filter-bar/` — major rewrite:
  - `FilterBar.tsx`: rewritten around a visibility prop, flat row list, footer.
  - `ConditionRow.tsx`: gain checkbox, green-applied state, per-row Apply button, `+ / −` per-row controls.
  - `OrGroup.tsx`, `RawWhereEditor.tsx`, `ConfirmDialog.tsx` (the raw→structured prompt): **deleted**.
  - `treeMutations.ts`: simplified (no `or_group` mutations).
  - `compileWhere.ts`: no longer compiles `or_group`; root combinator joining stays.
  - `FilterBar.module.css`: rewritten layout (rows, checkbox, footer strip, applied-green state).
  - `FilterBar.test.tsx` + all `__tests__/` under `src/modules/shared/filter-bar/`: **rewritten** from scratch.
- `src/modules/shared/filter-bar/`: components retained but pared down (`FilterBarShell`, `FilterBarBody`, `FilterBarActions`, `RowApplyButton`); removed: `FilterConnector`, `FilterSegmentedToggle`, `FilterTypeBadge`, `FilterRowAddButton`, `RootCombinatorToggle`.
- `src/modules/postgres/data/TableViewerTab.tsx`: visibility state (`filterBarVisible` ↔ `useFilterBarVisible` settings hook), updated `⌘F` handler (toggle, not focus), new keyboard-shortcut handlers (`⌘I`, `⌘⇧I`, `⌘↑`, `⌘↓`, `⌘←`, `⇧⌘↵`), new toggle button in subtab header row, drop `mode` field from `useTableFilter` consumers.
- `src/modules/postgres/data/types.ts`: drop `FilterMode` and `FilterNode.or_group`; flatten `FilterTree.children` to `Condition[]` plus a per-condition `enabled: boolean` flag; drop `mode` and `raw` from `FilterModel`. Helpers (`filterModelEquals`, `modelToPayload`, `trimLeadingWhere`) simplified.
- `src/modules/postgres/data/useTableFilter.ts`: drop `mode`-aware paths; emit `filter_tree` always; migration shim for legacy persisted shapes.

**Backend (Rust)**

- No wire-protocol break: the backend still accepts `filter_tree` with optional `or_group` children for backward compatibility with older clients (any future client never emits them, but the parser stays tolerant).
- No new commands. No deletions: `raw_where` keeps being honored (the SQL Editor path still needs it).

**Persistence / Migration**

- Per-table viewer settings: add `filter_bar_visible: boolean` (default `false`) and `filter_root_combinator: "AND" | "OR"` (default `"AND"`).
- Legacy `FilterModel` upgrades: on first load, any persisted model with `mode === "raw"` OR any tree containing an `or_group` child MUST be reset to the empty model (no migration to structured; the surface area was too small to justify the parsing cost — confirmed by user).

**Tests**

- All `FilterBar.test.tsx` + `__tests__/` tests under `shared/filter-bar/` are rewritten. `compileWhere.test.ts` loses OR-group scenarios. `treeMutations.test.ts` loses OR-group mutations. New tests cover visibility toggle, per-row checkbox, per-row Apply / Applied state, footer Apply All, ⌘I / ⌘⇧I / ⌘↑ / ⌘↓ / ⌘← / ⇧⌘↵ shortcuts, Unset, migration of legacy raw / OR-group models.

**Docs**

- `DESIGN.md` may need a tokens addition for the "applied green" state (or reuse an existing token). To be reviewed during design phase.
