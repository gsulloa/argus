## ADDED Requirements

### Requirement: Connection Manager has a fixed window size

The Connection Manager window (label `manager`) SHALL open at a single fixed size from every creation path and MUST NOT be resizable by the user. The fixed size MUST be identical whether the window is created at cold start or recreated after being closed. Persisted window state MUST NOT override the Manager's fixed size on subsequent launches. The Workspace window (label `workspace`) is unaffected and SHALL remain resizable with its geometry persisted across sessions.

#### Scenario: Manager opens at the fixed size at cold start

- **WHEN** the application starts and the Connection Manager window opens
- **THEN** its inner size is exactly the canonical fixed size (760×600)
- **AND** the window exposes no resize affordance

#### Scenario: Manager reopens at the fixed size after being closed

- **WHEN** the Manager window was closed and is then recreated (e.g. via `ensure_manager_window`)
- **THEN** the recreated window opens at the same canonical fixed size (760×600)
- **AND** it is not resizable

#### Scenario: User cannot resize the Manager window

- **WHEN** the user attempts to drag any edge or corner of the Manager window
- **THEN** the window dimensions do not change

#### Scenario: Persisted state does not override the fixed Manager size

- **WHEN** a saved window-state profile records a different Manager size from before this change
- **AND** the application launches and opens the Manager
- **THEN** the Manager opens at the canonical fixed size, not the persisted size

#### Scenario: Workspace remains resizable

- **WHEN** the user resizes the Workspace window and later relaunches the application
- **THEN** the Workspace window is resizable and reopens at its last persisted size
