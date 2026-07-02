## ADDED Requirements

### Requirement: Move a context query by drag-and-drop

In the per-connection Context Queries branch, query rows SHALL be draggable and folder nodes (and the branch root) SHALL be drop targets. Dropping a dragged query onto a folder MUST move the query into that folder by invoking `context_rename_query({ connection_id, from_path, to_path })`, where `to_path` keeps the query's existing slug (the last segment of its `path`) under the destination folder (`""` = root → bare slug). While a query is dragged over a valid drop target, the target MUST show a visual highlight. On a successful drop the branch MUST refresh, and a collapsed destination folder MUST auto-expand so the moved query is visible.

A move whose computed `to_path` equals the query's current `path` (dropping onto its own current folder) MUST be a no-op: no backend call and no error.

The context-menu "Move to folder…" action MUST remain available and MUST apply the same no-op guard.

#### Scenario: Drag a root query onto a folder

- **WHEN** the user drags query `top-customers` (at root) onto the `reports` folder node
- **THEN** `context_rename_query` is invoked with `from_path: "top-customers"` and `to_path: "reports/top-customers"`
- **AND** after refresh the query appears under `reports` (auto-expanded)

#### Scenario: Drag a query onto the root

- **WHEN** the user drags query `reports/top-customers` onto the branch root drop target
- **THEN** `context_rename_query` is invoked with `to_path: "top-customers"` and the query moves to the top level

#### Scenario: Dropping onto the current folder is a no-op

- **WHEN** the user drops a query onto the folder it already lives in
- **THEN** no `context_rename_query` call is made and no error toast appears

#### Scenario: Drop target highlights during drag

- **WHEN** a query is dragged over a folder node
- **THEN** that folder node shows a drop-target highlight until the drag leaves or drops
