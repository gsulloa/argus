## ADDED Requirements

### Requirement: Inactive tab content remains mounted

The center tab system SHALL keep every tab that has been activated at least once mounted in the DOM for the lifetime of the tab. Switching between tabs MUST change visibility only — it MUST NOT unmount or remount tab renderers. Tab renderers MAY rely on this guarantee to retain component state (data, scroll, selection, edit buffers) across activations without external persistence.

A tab that has been opened but never activated MAY be lazily mounted on first activation. Once mounted, it MUST remain mounted until the tab is closed.

Closing a tab MUST unmount its renderer immediately so that component state and any held resources are released.

Each tab renderer SHALL receive an `active: boolean` prop indicating whether it is the currently visible tab. Renderers that register window-level or document-level side-effects (keyboard listeners, focus handlers, document title updates) MUST gate those side-effects on `active === true` so that hidden tabs do not interfere with the active one.

#### Scenario: Inactive tab renderer is not unmounted

- **WHEN** the user activates tab A, then activates tab B
- **THEN** tab A's renderer is still mounted (its React component instance is preserved) and its DOM subtree is present but hidden
- **AND** tab A's internal state (such as fetched data, scroll position, and form input) is preserved

#### Scenario: Reactivating a tab does not remount it

- **WHEN** the user activates tab A, switches to tab B, then activates tab A again
- **THEN** tab A's renderer does NOT pass through an unmount/remount cycle
- **AND** any effect whose dependencies have not changed MUST NOT re-run

#### Scenario: First activation is lazy

- **WHEN** a tab is opened programmatically but the user has not yet activated it
- **THEN** the tab MAY be unmounted (no DOM, no component instance)
- **AND** when the user activates it for the first time, the renderer mounts and stays mounted thereafter

#### Scenario: Closing a tab releases its renderer

- **WHEN** the user closes tab A
- **THEN** tab A's renderer is unmounted on the next render
- **AND** any rows, edit buffers, or other in-memory state held by that renderer are eligible for garbage collection

#### Scenario: Hidden tab does not consume keyboard shortcuts

- **WHEN** two table-viewer tabs are open, tab A is active, and the user presses a per-tab keyboard shortcut (for example `Cmd+1`)
- **THEN** only tab A's handler responds
- **AND** tab B's window-level handler MUST NOT fire because `active === false` for tab B
