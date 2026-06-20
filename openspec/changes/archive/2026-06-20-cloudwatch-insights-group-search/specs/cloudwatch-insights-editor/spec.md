## ADDED Requirements

### Requirement: Log-group selector searches the whole account

The Insights toolbar's log-group multi-select SHALL provide a text input that searches **all** of the account's log groups server-side as the user types, not only a preloaded page. Typing a term queries the backend (`cloudwatch_list_log_groups` with `name_pattern`) and renders the matching groups; an empty term shows the first page. Queries SHALL be debounced and a newer query SHALL supersede an in-flight one so results do not arrive out of order. The currently-selected groups SHALL remain selected and visible even when they fall outside the active search results, so a selection can be assembled across multiple searches. The ≤ 50-group selection cap is unchanged.

#### Scenario: Typing finds a group not in the initial list

- **WHEN** the account has hundreds of log groups, the dropdown initially shows the first page, and the user types a substring of a group that is not on that page
- **THEN** the dropdown shows the matching group(s) fetched from the backend and the user can select one

#### Scenario: Selection persists across searches

- **WHEN** the user has selected group A, then types a term that returns a result set not containing A, and selects group B from those results
- **THEN** both A and B are selected, and A remains visible as selected in the dropdown summary/list

#### Scenario: Clearing the search restores the first page

- **WHEN** the user clears the search input
- **THEN** the dropdown shows the first page of log groups again, with current selections still marked

#### Scenario: No matches shows an empty state

- **WHEN** the typed term matches no log group
- **THEN** the dropdown shows a "no matches" message and the current selection is unaffected
