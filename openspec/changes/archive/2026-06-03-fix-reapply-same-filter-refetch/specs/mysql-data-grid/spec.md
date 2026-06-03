## ADDED Requirements

### Requirement: Filter Apply always refetches

Every commit from `draft` to `applied` (via **Apply All**, the `⌘↵` / `⇧⌘↵` shortcuts, or the per-row **Apply** button) in the MySQL filter bar MUST cause `mysql.queryTable` to be invoked, even when the resulting `applied` value is structurally equal to the previous `applied` value. The user's Apply gesture SHALL be treated as an explicit refresh signal.

`useTableData.refresh()` (the function bound to FilterBar's `onApply`) MUST unconditionally reset the buffer and trigger a first-page fetch. The internal `depsKey` guard in `useTableData` MUST NOT suppress the fetch when `refresh()` is invoked, even if `filterModel` (and therefore `depsKey`) is unchanged.

#### Scenario: Re-applying the same filter value refetches

- **WHEN** the user has `applied.rows = [{column: "n", op: "=", value: "1"}]`
- **AND** the user clears the value, then re-enters `"1"` and clicks `Apply All`
- **THEN** `applied` is structurally equal to its previous value
- **AND** `mysql.queryTable` is invoked again
- **AND** the grid displays the freshly-fetched rows

#### Scenario: Per-row Apply refetches even when the single row is unchanged

- **WHEN** `applied.rows === [R1]` and the user clicks per-row Apply on the same `R1`
- **THEN** `mysql.queryTable` is invoked again

#### Scenario: Empty Apply with already-empty applied still refetches

- **WHEN** `applied.rows === []` and the user presses `Apply All` from a draft with no enabled-complete rows
- **THEN** `mysql.queryTable` is invoked again with no filter

#### Scenario: Editing draft without Apply still does not fetch

- **WHEN** the user types into a row's value input without pressing Apply
- **THEN** `mysql.queryTable` is NOT invoked
