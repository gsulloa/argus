## ADDED Requirements

### Requirement: Reload current table query

The Postgres table viewer (Data subtab) SHALL provide a user-initiated **Reload** affordance that refetches the first page of the current relation, preserving the active filter model, sort order, and page size. Reload MUST be exposed as BOTH (a) a visible icon button placed in the SubtabHeader next to the Filter toggle (Data subtab only), and (b) a global keyboard shortcut **⌘R** (macOS) / **Ctrl+R** (Linux/Windows) bound while the table-viewer tab is the active tab.

The Reload button MUST use the lucide `RotateCw` icon at 13px, MUST render only when `active === "data"` (the Data subtab is selected), and MUST be disabled while `status === "loading-first"` or `status === "loading-first-retrying"`. When disabled, the icon MUST animate (continuous rotation) to indicate that a refetch is in progress. When the button is hovered, the title attribute MUST read `"Reload (⌘R)"`.

Triggering Reload (button click or shortcut) MUST advance the tab's `applyToken` monotonically (`setApplyToken((t) => t + 1)`), so the existing deps-key invalidation in `useTableData` causes an unconditional refetch even when the applied filter model is structurally equal to the previous one. Reload MUST NOT modify the draft or applied filter model, MUST NOT modify the sort or page size, MUST NOT clear the row selection, MUST NOT mutate the edit buffer, and MUST NOT change the current subtab.

The ⌘R / Ctrl+R shortcut MUST fire even when focus is inside an `<input>`, `<textarea>`, or `<select>` element (mirroring Dynamo's `whenInInput: true` behavior). The shortcut MUST be ignored when focus is inside a CodeMirror editor surface (detected via `document.activeElement.closest(".cm-editor")`). The shortcut handler MUST call `event.preventDefault()` whenever it acts, to suppress the browser/Tauri default reload behavior. The shortcut MUST only fire when the tab is the active tab (gated by the existing `active` prop and root-contains-focus guard).

#### Scenario: Reload button is visible on the Data subtab next to the Filter toggle

- **WHEN** the user opens a Postgres table viewer tab
- **THEN** the SubtabHeader renders a Reload icon button (lucide `RotateCw`, 13px) immediately after the Filter toggle
- **AND** hovering the button shows the title `"Reload (⌘R)"`

#### Scenario: Reload button is hidden on non-Data subtabs

- **WHEN** the user switches to the Structure, Raw, or Docs subtab
- **THEN** the Reload button is not rendered

#### Scenario: Clicking Reload refetches the first page

- **WHEN** the user clicks the Reload button while `status === "ready"`
- **THEN** the tab's `applyToken` is incremented by 1
- **AND** `useTableData` issues a fresh `postgres_query_table` request with the current `limit`, `offset: 0`, `order_by`, and `applied` filter model
- **AND** the request payload is identical to what would have been sent had the user pressed Apply with the same filter values

#### Scenario: ⌘R fires the same refetch as the button

- **WHEN** the Postgres table viewer tab is active and the user presses ⌘R (or Ctrl+R on non-macOS)
- **THEN** the same refetch is issued and `applyToken` is incremented by 1
- **AND** the browser/Tauri default page-reload behavior does NOT occur (the handler called `preventDefault()`)

#### Scenario: ⌘R fires from input focus

- **WHEN** the user is focused inside a filter-bar value input and presses ⌘R
- **THEN** the refetch is issued
- **AND** the input's text content is NOT cleared or modified

#### Scenario: ⌘R is suppressed when CodeMirror has focus

- **WHEN** the user is focused inside a CodeMirror editor (e.g. a raw SQL surface mounted in the same tab) and presses ⌘R
- **THEN** no refetch is issued
- **AND** the default browser action (if any) MAY proceed

#### Scenario: Reload button is disabled and spins during first-page load

- **WHEN** the table viewer is in `status === "loading-first"` (or `"loading-first-retrying"`)
- **THEN** the Reload button is disabled and its icon rotates continuously
- **AND** clicking it has no effect

#### Scenario: Reload preserves filter, sort, page size, edit buffer, and selection

- **GIVEN** the user has applied a filter `country = 'CL'`, sorted by `created_at DESC`, set page size to 100, selected three rows, and made one uncommitted row edit
- **WHEN** the user triggers Reload
- **THEN** the refetched first page reflects the same filter, sort, and page size
- **AND** the edit buffer still contains the uncommitted edit
- **AND** the row selection is preserved
- **AND** the active subtab remains "data"

#### Scenario: Reload does not fire from inactive tabs

- **GIVEN** two Postgres table viewer tabs are open, only the second is active
- **WHEN** the user presses ⌘R
- **THEN** only the active (second) tab refetches
- **AND** the inactive (first) tab does not issue a new request
