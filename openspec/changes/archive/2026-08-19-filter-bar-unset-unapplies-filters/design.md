## Context

The Postgres table viewer keeps two filter models per `(connectionId, schema, relation)`,
persisted together in one `pgTableFilter:*` settings record by `useTableFilter`:

- `draft` — what the filter bar renders and edits.
- `applied` — the only half that reaches `postgres_query_table` /
  `postgres_count_table` (via `modelToPayload`), and the only half that drives the
  bottom-bar filter chip and the footer `SQL` prefill.

`TableViewerTab` already owns both commit paths:

```ts
const onApplyFilters = useCallback(() => {
  const enabledRows = draft.rows.filter((r) => r.enabled && isCompleteRow(r));
  setApplied({ rows: enabledRows, combinator: draft.combinator });
  setApplyToken((t) => t + 1);            // "Filter Apply always refetches"
}, [draft, setApplied]);

const onApplyOnlyRow = useCallback((index: number) => { /* applied = [row] */ }, …);
```

`FilterBar` is a controlled component: it never writes `applied`, it only calls
`onApplyAll` / `onApplyOnlyRow`. Its two draft-scoped footer actions, `Clear all`
(`clearAllRows`) and today's `Unset` (`unsetAllOperators`), both go through
`onDraftChange`.

PR #283 built `Unset` on the draft side and introduced `FilterRow.op: Operator | null`
to make an operator-less row inert. v0.8.6 (released 2026-08-19) shipped that, so
`op: null` can already exist on disk for any user who clicked `Unset`.

The correction this change makes is a **side swap**: `Unset` moves from the `draft`
side of the bar to the `applied` side. Everything else about the bar stays put.

## Goals / Non-Goals

**Goals:**

- `Unset` stops the grid from filtering, in one click, while leaving the filter form
  pixel-identical — same rows, same operators, same values, same checkboxes, same
  order, same combinator.
- Re-applying is one gesture (`Apply All`), with zero per-row re-selection.
- v0.8.6-persisted records containing `op: null` keep loading, keep rendering, and
  stay recoverable — no filter record is silently discarded on upgrade.
- The change stays inside the Postgres filter bar and `TableViewerTab`; no wire,
  Rust, or persistence-schema change.

**Non-Goals:**

- Removing the null-operator state from the type system. It is now legacy-only, but
  ripping it out would break upgrade compatibility (see D3).
- Adding an "undo unset" / restore-previous-applied affordance. `Apply All` already
  restores the form, and `draft` is the durable record of what the user built.
- A keyboard shortcut for `Unset`. The footer strip is already dense with hints.
- MySQL / MSSQL / Dynamo / Athena / CloudWatch filter surfaces — none render `Unset`.

## Decisions

### D1 — `Unset` clears `applied`, never `draft`

`FilterBar` gains an `onUnsetFilters(): void` prop, symmetric with `onApplyAll` and
`onApplyOnlyRow`. `handleUnset` becomes a straight call to it — no `onDraftChange`.

`TableViewerTab` implements it as:

```ts
const onUnsetFilters = useCallback(() => {
  setApplied({ rows: [], combinator: draft.combinator });
  setApplyToken((t) => t + 1);
}, [draft.combinator, setApplied]);
```

`combinator` is carried over from `draft` purely so the persisted `applied` half stays
coherent with the bar's current AND/OR selection; with `rows: []` it has no effect on
the query (`modelToPayload` returns `{}` when there are no complete enabled rows).

*Alternative considered — set `enabled: false` on every draft row and re-run
`onApplyFilters`.* Rejected: it satisfies "stop filtering" but violates "el formulario
siga tal cual está" — every checkbox flips, and restoring means re-checking each row.

*Alternative considered — keep `Unset` draft-only and let the user press `Apply All`
afterwards.* Rejected: that is a two-gesture path for the single thing the user asked
for, and the intermediate state (draft with unchecked/inert rows) is exactly the form
mutation this change exists to avoid.

### D2 — `Unset` is a commit gesture, so it always refetches

The existing "Filter Apply always refetches" requirement treats every `draft → applied`
commit as an explicit refresh signal backed by a monotonic `applyToken`. `Unset` writes
`applied`, so it takes the same treatment: the token advances unconditionally, including
when `applied.rows` was already `[]`.

*Alternative considered — early-return when `applied.rows.length === 0`.* Rejected:
it saves one query at the cost of making `Unset` the single commit gesture in the bar
that sometimes doesn't refresh, contradicting an explicit spec requirement.

### D3 — The null-operator state is retained as legacy-only, not reverted

`unsetAllOperators` is deleted (its only caller is gone), but every *reader* of the
null state stays: `FilterRow.op: Operator | null`, the `isCompleteRow` null guard, the
`compileWhere` / `modelToPayload` `isCompleteRow` filters, `OperatorPicker`'s disabled
`—` placeholder, `ValueInput`'s shape-derived control selection, `ConditionRow`'s
"unset row stays unset across a column change" branch, and `migrateLegacyFilterModel`'s
`op: typeof r["op"] === "string" ? … : null` coercion plus its "`op` may legitimately be
absent" guard.

Rationale: v0.8.6 is already released, so `op: null` exists on real disks. Tightening
`migrateLegacyFilterModel` to reject a null `op` would hit its "corrupt record" path and
reset the user's **entire** persisted filter for that table — the exact regression PR
#283 called out and guarded against. Keeping the readers costs nothing at runtime and
gives those users a form they can repair operator-by-operator.

*Alternative considered — coerce `op: null` → a concrete operator at migration time.*
Rejected: `migrateLegacyFilterModel` has no `columns` metadata, so it cannot know which
operators are legal for a row's column (`operatorsForColumn` needs `data_type` and
`is_nullable`). It would have to guess `"="`, silently inventing a predicate the user
never wrote — worse than showing `—`.

### D4 — Footer copy: `Filters: [Unset]`, same position

The prefix changes from `Operator:` to `Filters:` and the tooltip from "Clear the
operator on every row, keeping columns and values" to "Stop applying the filters — the
filter form is kept as is". The control keeps its footer slot at the far right of
`footerLeft`, deliberately non-adjacent to `Clear all`, and keeps `styles.unsetBtn`.

Rationale: the button's name is what users and the issue refer to, so it stays `Unset`;
only the scope prefix was wrong. Keeping the position preserves muscle memory from
v0.8.6 and preserves the existing spec constraint that `Clear all` and `Unset` are never
rendered next to each other.

*Alternative considered — move `Unset` next to `Apply All` on the right, since it is
now the inverse of that action.* Rejected for this change: adjacency to the primary
action invites the misclick (unfiltering the grid mid-work) that the footer layout was
arranged to avoid, and the relocation is a design question separate from the fix.

### D5 — Post-`Unset` state reads as "dirty", by design

After `Unset`, `draft` holds complete rows that are no longer in `applied`, so
`filterModelEquals(draft, applied)` is false and the dirty pip (`●`) appears, while
`buildAppliedSet` returns empty and every row shows the neutral `Apply` label instead of
the green `Applied` badge. That is the honest reading: *you have a filter form that is
not in force*. No suppression logic is added.

The bottom-bar chip follows the same source of truth — `filterCount = applied.rows.length`
drops to `0`, so the "N filters" chip disappears.

### D6 — `Clear all` and the bottom-bar `✕` are untouched

Three distinct escape hatches, now cleanly separated by what each destroys:

| Control | `draft` | `applied` | Refetch |
| --- | --- | --- | --- |
| `Filters: Unset` (footer) | untouched | → `[]` | yes |
| `Clear all` (footer) | → one empty row | untouched | no |
| `✕` on the bottom-bar filter chip | → empty | → empty | yes (existing `resetFilter`) |

## Risks / Trade-offs

- **[Behavioural whiplash across two releases]** v0.8.6's CHANGELOG told users `Unset`
  clears operators; this change makes it clear the applied filter instead. → Ship an
  explicit `Changed` entry under `Unreleased` that names the correction and points at
  #278, so the release notes read as a deliberate follow-up rather than a silent flip.

- **[Orphaned null-operator rows]** A v0.8.6 user who clicked `Unset` reopens a table
  and sees rows with `—` operators that nothing in the new UI produces, with no bulk way
  to repair them. → The rows stay individually repairable via the operator picker (D3),
  `Clear all` remains available as the bulk reset, and the population is bounded to
  users who clicked `Unset` during a single day-old release.

- **[`Unset` looks like a no-op when nothing is applied]** Clicking it with
  `applied.rows === []` refetches and changes nothing visible. → Accepted; it is
  consistent with `Apply All` on an empty draft, which also refetches (and unlike
  `Apply All`, `Unset` has no misleading inline status to add).

- **[Dead code retained]** The null-operator readers are load-bearing only for legacy
  records. → Their purpose is documented in code comments as legacy-compat (task 4.1),
  and the spec requirement is reframed so a future reader knows the state is
  no-longer-producible rather than assuming a missing UI path.

## Migration Plan

No data migration. Persisted records are read through the unchanged
`normalizePersistedFilter` → `migrateLegacyFilterModel` path; records written by
v0.8.6 (`op: null`) and by this version (`op` always a string, `applied.rows` possibly
`[]`) are both valid under the same shape. Rollback is a straight revert of the
frontend diff — a record written after this change is indistinguishable from a v0.8.6
record that was never unset.

## Open Questions

None blocking. One deferred design question, noted in D4: whether `Unset` should
eventually live beside `Apply All` as its visual inverse. Out of scope here.
