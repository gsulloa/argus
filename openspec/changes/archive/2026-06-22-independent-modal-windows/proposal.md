## Why

The "new connection" form and the in-app feedback form are currently rendered as Radix `Dialog` overlays embedded inside whichever window opened them (the compact Manager window, 760×600). In that small, role-specific shell they render badly — the form is taller than the viewport, controls crowd the chrome, and the overlay fights the window's own layout. Both flows are self-contained tasks that deserve their own canvas. The app already runs a multi-window architecture (Manager + Workspace, routed by Tauri window label), so promoting these two flows to dedicated native windows is a natural fit and fixes the reported visual defect (issue #175).

## What Changes

- The **connection create/edit form** opens in its own native Tauri window (label `connection-form`) instead of as an in-window Radix dialog overlay. The kind picker selection and the "edit connection" affordance route to this window; on submit the window persists the connection and notifies the opener, then closes.
- The **feedback form** opens in its own native Tauri window (label `feedback`) instead of as an in-window Radix dialog overlay. Both entry points (command palette, shell affordance) route to this window.
- Both new windows are sized for their content, single-instance (re-focus if already open), and route by window label through the existing `main.tsx` bootstrap.
- Cross-window coordination uses Tauri events so the opener (Manager/Workspace) refreshes its connection list and the feedback host learns the submission outcome.
- The embedded Radix `Dialog` mounts for these two flows are removed from the shared provider tree.

## Capabilities

### New Capabilities
- `connection-form-window`: The connection create/edit form is presented in a dedicated native window — opening/routing by label, single-instance focus, prefill for edit mode, submit-and-notify-opener, and window lifecycle (close on success/cancel).

### Modified Capabilities
- `feedback-form`: The feedback form's presentation surface changes from an embedded dialog to a dedicated native window; entry points open the window, and submission outcome is coordinated across windows. Form fields, validation, diagnostic metadata, attachments, and submission semantics are unchanged.

## Impact

- **Frontend**: `main.tsx` (label routing adds `connection-form` and `feedback` roots), new window-root app components, removal of the embedded `ConnectionForm`/`FeedbackDialog` mounts from `FormController`/`FeedbackHost`/`ManagerShell`/`App.tsx`, kind-picker and edit triggers re-pointed to a "ensure window" invoke, cross-window event wiring.
- **Rust (`src-tauri`)**: new `ensure_connection_form_window` / `ensure_feedback_window` commands alongside the existing `ensure_workspace_window` / `ensure_manager_window`; window labels added to `capabilities/default.json`.
- **Specs**: new `connection-form-window` spec; delta to `feedback-form`. `dual-window-shell` is unaffected — these are transient utility windows, not new primary roles.
- **Design**: window sizing/chrome must follow `DESIGN.md`; no new visual language is introduced beyond moving existing form content into a right-sized window.
