## ADDED Requirements

### Requirement: Filter Apply always refetches

Every commit from `draft` to `applied` (via **Apply All**, the `⌘↵` / `⇧⌘↵` shortcuts, or the per-row **Apply** button) MUST cause `postgres.queryTable` to be invoked, even when the resulting `applied` value is structurally equal to the previous `applied` value. The user's Apply gesture SHALL be treated as an explicit refresh signal, not merely as a state-equality trigger.

The implementation MUST NOT rely solely on structural equality of `applied` to decide whether to refetch. A monotonically-advancing token (or equivalent mechanism) MUST be threaded into the data-fetch dependency key so that pressing Apply with an unchanged filter model still produces a network round-trip and a fresh first page.

This requirement explicitly overrides any optimisation that would dedupe a fetch on the grounds that "the filter model didn't change". Edits to `draft` that never reach `applied` MUST still NOT trigger a fetch (the `Editing a row updates draft only` scenario in `Filter draft and applied state` is preserved).

#### Scenario: Re-applying the same filter value refetches

- **WHEN** the user has `applied.rows = [{column: "n", op: "=", value: "1"}]` showing a stale result set
- **AND** the user clears the value input to empty (still in `draft`, not committed)
- **AND** the user re-enters `"1"` and clicks `Apply All`
- **THEN** `applied` is structurally equal to its previous value
- **AND** `postgres.queryTable` is invoked again
- **AND** the grid displays the freshly-fetched rows, including any rows created externally since the previous Apply

#### Scenario: Per-row Apply refetches even when the single row is unchanged

- **WHEN** `applied.rows === [R1]` and the user clicks the per-row Apply on the same `R1` in `draft`
- **THEN** `applied` is structurally equal to its previous value
- **AND** `postgres.queryTable` is invoked again

#### Scenario: Empty Apply with already-empty applied still refetches

- **WHEN** `applied.rows === []` (no filters) and the user presses `Apply All` from a draft with no enabled-complete rows
- **THEN** `postgres.queryTable` is invoked again with no `filter_tree` and no `raw_where`
- **AND** the inline `No filters enabled` status appears (existing behaviour preserved)

#### Scenario: Editing draft without Apply still does not fetch

- **WHEN** the user types into a row's value input without pressing Apply
- **THEN** `postgres.queryTable` is NOT invoked
- **AND** `applied` is unchanged
