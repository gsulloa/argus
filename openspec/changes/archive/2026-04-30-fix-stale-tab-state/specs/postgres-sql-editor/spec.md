## ADDED Requirements

### Requirement: Prefilled SQL survives StrictMode mount race

When a `postgres-query` tab opens with a non-empty `payload.sql` (for example, via the data viewer's `Open in SQL Editor` action), the editor MUST mount with `payload.sql` as its initial document, on every code path — including under React 18 `<React.StrictMode>` dev double-mount.

The in-session SQL buffer cleanup ("closing a tab discards the buffer") MUST be tied to the actual tab-close gesture (the close-handler registry consulted by `TabStrip`), NOT to React unmount alone. A StrictMode replay (mount → cleanup → mount on the same tab) MUST NOT clobber the buffer with the empty string between the first mount's seeding and the second mount's read.

#### Scenario: Open in SQL Editor lands on the prefilled SQL in dev

- **WHEN** the user clicks `Open in SQL Editor` from a table viewer that has a non-empty applied filter
- **AND** the app is running with `<React.StrictMode>` enabled (dev mode)
- **THEN** the new query tab's editor mounts with the SQL produced by `compilePrefilledSelect` (`SELECT * FROM ... WHERE ... LIMIT N`) as its initial document
- **AND** the editor never displays an empty document for the lifetime of the tab

#### Scenario: Open in SQL Editor lands on the prefilled SQL in prod

- **WHEN** the user clicks `Open in SQL Editor` in production (no StrictMode replay)
- **THEN** the editor mounts with the same `compilePrefilledSelect` output

#### Scenario: Closing a query tab still removes the buffer

- **WHEN** the user closes a `postgres-query` tab via the close button or `Mod-W`
- **THEN** the `pgQueryBuffer:<tabId>` settings key is removed
- **AND** no confirmation dialog is shown
