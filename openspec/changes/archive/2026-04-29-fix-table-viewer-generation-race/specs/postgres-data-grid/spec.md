## ADDED Requirements

### Requirement: Deterministic first-page load on viewer mount

The data viewer's loading state machine SHALL guarantee that, on a clean mount with the connection reachable and the relation accessible, the viewer transitions from `loading-first` to either `ready` (with rows populated) or `error` (with the error surfaced) without depending on any subsequent re-render, user interaction, or upstream state change. The transition MUST hold under React 18 StrictMode (mount → unmount → remount) so that development and production behave identically. Any in-flight cancellation token used to invalidate stale responses MUST NOT be allowed to invalidate the fetch issued by the initial mount when no concurrent reset has occurred.

#### Scenario: Empty table renders empty state, not infinite spinner

- **WHEN** the user activates a table whose `SELECT` returns zero rows AND the underlying Tauri command resolves successfully
- **THEN** the viewer transitions out of `loading-first` to `ready`
- **AND** the spinner is no longer shown
- **AND** the data grid is rendered (visibly empty rather than the loading placeholder)

#### Scenario: Non-empty table renders rows on first mount

- **WHEN** the user activates a table whose `SELECT` returns N rows AND the underlying Tauri command resolves successfully
- **THEN** the viewer transitions to `ready`
- **AND** the grid renders all N returned rows in column order

#### Scenario: First-page error surfaces to the error banner

- **WHEN** the user activates a table AND the underlying Tauri command rejects with an `AppError`
- **THEN** the viewer transitions out of `loading-first` to `error`
- **AND** the error banner is shown with the error message and a retry control

#### Scenario: StrictMode mount/unmount/remount does not strand the viewer

- **WHEN** the viewer hook is mounted under `<React.StrictMode>` so that React invokes mount → cleanup → mount a second time
- **THEN** the second mount's first-page fetch reaches a `ready` (or `error`) terminal state
- **AND** the viewer does not remain stuck in `loading-first` after both mounts' fetches resolve

#### Scenario: Loading→ready transition does not require a side-effectful re-render

- **WHEN** the user activates a table AND no other state changes after mount (no filter change, no sort change, no page-size change, no async settings load)
- **THEN** the viewer still transitions to `ready` once the first-page fetch resolves
- **AND** the transition does not depend on `usePageSize` finishing its async load with a non-default value
