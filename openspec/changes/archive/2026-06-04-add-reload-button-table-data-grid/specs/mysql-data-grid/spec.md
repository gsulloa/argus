## ADDED Requirements

### Requirement: Reload current table query

The MySQL table viewer (Data subtab) SHALL provide a user-initiated **Reload** affordance that refetches the first page of the current relation, preserving the active filter model, sort order, and page size. Reload MUST be exposed as BOTH (a) a visible icon button placed in the tab header next to the Filter toggle (Data subtab only), and (b) a global keyboard shortcut **⌘R** (macOS) / **Ctrl+R** (Linux/Windows) bound while the table-viewer tab is the active tab.

The Reload button MUST use the lucide `RotateCw` icon at 13px, MUST render only when the Data subtab is active, and MUST be disabled while `tableData.isLoading` reflects the first-page fetch path. When disabled, the icon MUST animate (continuous rotation). The hover title MUST read `"Reload (⌘R)"`.

Triggering Reload (button click or shortcut) MUST call `tableData.refresh()`, which is the existing always-refetch entry point on `useTableData` (it bumps the internal `applyToken` and reissues the current query unconditionally). Reload MUST NOT modify the draft or applied filter model, MUST NOT modify the sort or page size, MUST NOT clear the row selection, MUST NOT mutate the edit buffer, and MUST NOT change the current subtab.

The ⌘R / Ctrl+R shortcut MUST fire even when focus is inside an `<input>`, `<textarea>`, or `<select>` element. The shortcut MUST be ignored when focus is inside a CodeMirror editor surface. The shortcut handler MUST call `event.preventDefault()` whenever it acts, to suppress the browser/Tauri default reload. The shortcut MUST only fire when the tab is the active tab.

#### Scenario: Reload button visible on Data subtab

- **WHEN** the user opens a MySQL table viewer tab on the Data subtab
- **THEN** a Reload icon button (lucide `RotateCw`, 13px) is rendered next to the Filter toggle
- **AND** hovering shows the title `"Reload (⌘R)"`

#### Scenario: Reload button hidden on non-Data subtabs

- **WHEN** the user switches to a non-Data subtab (e.g. Structure, Raw)
- **THEN** the Reload button is not rendered

#### Scenario: Clicking Reload invokes tableData.refresh

- **WHEN** the user clicks the Reload button while `tableData.isLoading === false`
- **THEN** `tableData.refresh()` is called exactly once
- **AND** the internal `applyToken` advances by 1
- **AND** `useTableData` issues a fresh `mysql_query_table` request with the current `limit`, `offset: 0`, `order_by`, and applied filter model

#### Scenario: ⌘R fires the same refetch as the button

- **WHEN** the MySQL table viewer tab is active and the user presses ⌘R (or Ctrl+R on non-macOS)
- **THEN** `tableData.refresh()` is called
- **AND** the default page-reload behavior does NOT occur

#### Scenario: ⌘R fires from input focus

- **WHEN** the user is focused inside a filter-bar input and presses ⌘R
- **THEN** `tableData.refresh()` is called
- **AND** the input's value is not modified

#### Scenario: ⌘R is suppressed when CodeMirror has focus

- **WHEN** the user is focused inside a CodeMirror surface and presses ⌘R
- **THEN** `tableData.refresh()` is NOT called

#### Scenario: Reload disabled during first-page fetch

- **WHEN** the data view is in a first-page loading state
- **THEN** the Reload button is disabled
- **AND** the icon rotates continuously to signal in-flight work

#### Scenario: Reload preserves filter, sort, page size, edit buffer, and selection

- **GIVEN** filters, sort, page size, row selection, and pending edits are all set
- **WHEN** the user triggers Reload
- **THEN** all of those values are preserved across the refetch

#### Scenario: Reload does not fire from inactive tabs

- **GIVEN** two MySQL table viewer tabs are open, only the second is active
- **WHEN** the user presses ⌘R
- **THEN** only the active tab refetches
