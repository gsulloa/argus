## ADDED Requirements

### Requirement: Log-group tree search

The sidebar log-group tree SHALL provide a text input that searches all of the account's log groups server-side as the user types, reusing the `cloudwatch_list_log_groups` `name_pattern` filter. Typing a term reloads the tree's groups filtered by that term (debounced); an empty term restores the full paginated list. The "load more groups" action SHALL carry the active search term so paging stays within the filtered set. Loading, no-match, and error states SHALL be shown in the tree. Log streams (the second tree level) are not affected.

#### Scenario: Typing filters the tree to matching groups

- **WHEN** an account has many log groups and the user types a substring into the tree's search field
- **THEN** the tree reloads to show only log groups whose name contains that substring, including groups that were not on the initially loaded page

#### Scenario: Clearing the search restores the full list

- **WHEN** the user clears the search field
- **THEN** the tree reloads the first page of all log groups with the "load more groups" affordance, as before

#### Scenario: Load more stays within the filtered set

- **WHEN** a search term is active and more matches exist than one page
- **THEN** activating "load more groups" fetches the next page of matches for the same term

#### Scenario: No matches shows an in-tree message

- **WHEN** the typed term matches no log group
- **THEN** the tree shows a "no log groups match" message and no group rows

#### Scenario: Streams are unaffected

- **WHEN** the user expands a matched log group
- **THEN** its streams load lazily as before, independent of the group search
