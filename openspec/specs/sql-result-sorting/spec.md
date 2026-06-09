# sql-result-sorting Specification

## Purpose
TBD - created by archiving change sort-sql-editor-results. Update Purpose after archive.
## Requirements
### Requirement: Client-side sort of SQL result grids

Every SQL editor result grid (Postgres, MySQL, MSSQL, Athena) that renders a `kind: "rows"` result SHALL support sorting the already-loaded rows by a single column via a click on that column's header. Sorting MUST be performed client-side over the in-memory result set: it MUST NOT re-query the database, MUST NOT mutate the original result rows, and MUST work identically on read-only connections (including Athena).

The result grid SHALL hold sort state as an `orderBy` value (an array of `{ column, direction }`, where `direction` is `"asc"` or `"desc"`) that is empty when the result is unsorted. The displayed rows MUST be derived from the raw result plus the current `orderBy`; the raw result MUST remain unchanged. When a new run replaces the result, or the columns prop shape changes, the `orderBy` MUST reset to unsorted.

#### Scenario: Sorting reorders only the displayed rows

- **WHEN** a SELECT returns rows and the user clicks a column header
- **THEN** the grid re-renders the same rows reordered by that column
- **AND** no new query is issued to the database
- **AND** the underlying result payload is left unchanged

#### Scenario: Sorting works on a read-only / Athena result

- **WHEN** the user runs a SELECT on an Athena connection (or any read-only connection) and clicks a column header
- **THEN** the rows are reordered locally
- **AND** no `StartQueryExecution` / re-query is triggered

#### Scenario: New run resets sort

- **WHEN** the user has sorted a result, then runs a new query whose result has a different columns shape
- **THEN** the grid renders the new result unsorted (`orderBy` is empty)

### Requirement: Header click cycles asc → desc → unsorted

Clicking a column header SHALL cycle that column's sort direction in three states: from unsorted to ascending, from ascending to descending, and from descending back to unsorted. Sorting is single-column in v1: clicking a different column's header SHALL replace the sort with that column ascending (it MUST NOT accumulate multiple sort columns).

#### Scenario: First click sorts ascending

- **WHEN** a column is unsorted and the user clicks its header
- **THEN** the rows sort ascending by that column

#### Scenario: Second click sorts descending

- **WHEN** a column is sorted ascending and the user clicks its header again
- **THEN** the rows sort descending by that column

#### Scenario: Third click clears the sort

- **WHEN** a column is sorted descending and the user clicks its header again
- **THEN** the sort is cleared and rows return to the result's original order

#### Scenario: Clicking another column replaces the sort

- **WHEN** column A is sorted (ascending or descending) and the user clicks column B's header
- **THEN** the rows sort ascending by column B
- **AND** column A is no longer a sort key

### Requirement: Sort direction indicator on headers

Each result grid header SHALL display a direction indicator on the actively sorted column: `↑` for ascending and `↓` for descending. Columns that are not the active sort key MUST NOT display an indicator.

#### Scenario: Ascending shows up arrow

- **WHEN** a column is sorted ascending
- **THEN** its header shows a `↑` indicator
- **AND** no other column shows a sort indicator

#### Scenario: Descending shows down arrow

- **WHEN** a column is sorted descending
- **THEN** its header shows a `↓` indicator

#### Scenario: Cleared sort removes the indicator

- **WHEN** the sort on a column is cleared
- **THEN** that column's header shows no sort indicator

### Requirement: Stable, type-aware, null-safe comparison

The client-side sort SHALL be stable: rows with equal sort keys MUST preserve their original relative order from the result. The comparator MUST be value-aware, deriving an ordering from the typed cell envelope (and the column's declared type as a fallback) so that:

- numeric columns sort numerically (not lexically),
- date/timestamp columns sort chronologically,
- text columns sort lexically.

`null`, `undefined`, and absent cells MUST sort deterministically to the same end of the order (grouped together, not interleaved with present values) regardless of ascending vs. descending. When a column contains genuinely mixed value types, the comparator MUST apply a defined, deterministic fallback ordering rather than throwing or producing an unstable result.

#### Scenario: Numeric column sorts numerically

- **WHEN** a column has values `9`, `10`, `100` and the user sorts ascending
- **THEN** the rows order as `9`, `10`, `100` (not `10`, `100`, `9`)

#### Scenario: Nulls group at one end

- **WHEN** a column mixes present values and `null` cells and the user sorts ascending
- **THEN** all `null` rows are grouped together at one end
- **AND** the present values are sorted among themselves

#### Scenario: Equal keys preserve original order

- **WHEN** two rows have the same value in the sorted column
- **THEN** their relative order in the sorted output matches their order in the original result

#### Scenario: Descending keeps nulls grouped

- **WHEN** the same null-mixed column is sorted descending
- **THEN** the `null` rows remain grouped together (not scattered between present values)

