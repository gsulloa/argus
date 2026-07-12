## MODIFIED Requirements

### Requirement: Open context query in editor tab

Activating a context-query entry SHALL open a SQL-editor tab (engine-appropriate) pre-populated with the query body. Before opening the tab, the platform SHALL switch focus to the query's connection so the opened tab is surfaced in the visible tab set even when that connection was not previously the focused one. If the query's meta declares one or more `params`, the tab SHALL render a parameter strip above the editor with one input per param, pre-filled with each param's `default` value (or empty if no default). The tab title SHALL be the query's `name`. Editing the body in the tab SHALL NOT modify the file on disk.

#### Scenario: Tab opens with body and title

- **WHEN** the user activates `top-customers` whose meta `name` is "Top customers since date"
- **THEN** a new editor tab opens titled "Top customers since date" with the SQL body in the editor

#### Scenario: Activating surfaces the tab for a non-focused connection

- **WHEN** connections A and B are both connected, A is currently focused, and the user activates a context query under connection B's Context Queries branch
- **THEN** focus switches to connection B and the newly opened editor tab is visible in B's tab set (it does not land in a hidden per-connection tab set)

#### Scenario: Param strip rendered with defaults

- **WHEN** the query's meta declares `params: [{ name: since, type: timestamp, default: "2026-01-01" }, { name: limit, type: int, default: 50 }]`
- **THEN** the tab renders two inputs labelled `since` and `limit` pre-filled with `2026-01-01` and `50`

#### Scenario: No params means no strip

- **WHEN** the query's meta has `params: []` or no meta file
- **THEN** the tab renders no parameter strip

#### Scenario: Edits in the tab do not write to disk

- **WHEN** the user edits the body in the editor tab and runs it
- **THEN** the file on disk is unchanged
