## 1. Rust window commands & capabilities

- [x] 1.1 Add `ensure_connection_form_window(app, intent)` in `src-tauri/src/platform/open_connections.rs` (or a sibling module), mirroring `ensure_workspace_window`: focus if the `connection-form` window exists, else build with content-appropriate `inner_size`/`min_inner_size`, resizable, centered.
- [x] 1.2 Add `ensure_feedback_window(app, active_engine)` the same way for the `feedback` label.
- [x] 1.3 Stash the pending intent (mode/engine/connection id for connection-form; active engine type for feedback) in Tauri managed state when opening, and add `connection_form_intent()` / `feedback_intent()` commands the windows call on mount to read it.
- [x] 1.4 On re-trigger of `connection-form` with a new intent, update the stashed intent and emit `connection-form:intent-changed`, then focus.
- [x] 1.5 Register the new commands in the Tauri builder and add `connection-form` and `feedback` to the `windows` array in `src-tauri/capabilities/default.json`.

## 2. Frontend window roots & label routing

- [x] 2.1 Add `connection-form` and `feedback` cases to the label switch in `packages/app/src/main.tsx`, mounting `ConnectionFormApp` and `FeedbackApp`.
- [x] 2.2 Create `ConnectionFormApp` root: read intent via `connection_form_intent()` on mount, mount minimal providers, render the engine's form body full-window, listen for `connection-form:intent-changed` to re-prefill.
- [x] 2.3 Create `FeedbackApp` root: read active engine via `feedback_intent()` on mount, mount minimal providers, render the feedback form body full-window.

## 3. Reuse form bodies (drop overlay chrome)

- [x] 3.1 Refactor `modules/<engine>/ConnectionForm.tsx` so the field body is reusable without the `Dialog.Root`/`Dialog.Portal`/overlay wrapper; render it full-window in `ConnectionFormApp`.
- [x] 3.2 Refactor `platform/feedback/FeedbackDialog.tsx` the same way; render the body full-window in `FeedbackApp`.
- [x] 3.3 Verify form bodies follow `DESIGN.md` in the new full-window layout (fonts, accent, borders, spacing, motion).

## 4. Re-point triggers to open windows

- [x] 4.1 Change `ConnectionKindPicker`/`useKindPicker` so selecting an engine invokes `ensure_connection_form_window` with a `create` intent instead of calling `<engine>.openCreate()`.
- [x] 4.2 Change the "edit connection" affordance(s) to invoke `ensure_connection_form_window` with an `edit` intent (engine kind + connection id) instead of `openEdit(initial)`.
- [x] 4.3 Change the feedback affordance and command-palette "Send feedback" command to invoke `ensure_feedback_window` (passing the active engine type) instead of dispatching `argus:feedback:open`.

## 5. Cross-window coordination

- [x] 5.1 On successful create/update in `ConnectionFormApp`, call `connections.create`/`connections.update`, emit the connection-list refresh event, then close the window; keep the window open with the error and preserved values on failure.
- [x] 5.2 Ensure the Manager and Workspace refresh their connection lists on that event (and on focus regain as a fallback).
- [x] 5.3 On successful feedback submission, emit `argus:feedback:submitted`, clear the draft, and close; keep the window open with preserved draft on failure.
- [x] 5.4 Have `FeedbackHost` reset any pending state on `argus:feedback:submitted` (it no longer renders the dialog).

## 6. Remove embedded mounts

- [x] 6.1 Remove the embedded `ConnectionForm` render from the per-engine `FormController` providers (keep create/edit state plumbing only where still needed for triggers, or remove if fully superseded).
- [x] 6.2 Remove the `FeedbackDialog` mount from `FeedbackHost`, `ManagerShell`, and `App.tsx`, and drop the `argus:feedback:open` listener.
- [x] 6.3 Delete now-unused overlay CSS/portal code and the `argus:feedback:open` event if no longer referenced.

## 7. Verify

- [x] 7.1 New connection: kind picker → form window opens, create succeeds, Manager list refreshes, window closes.
- [x] 7.2 Edit connection: form window opens prefilled, update succeeds, list reflects changes, window closes.
- [x] 7.3 Re-trigger while open focuses the single window (both connection-form and feedback); cancel closes without persisting; failure preserves the draft.
- [x] 7.4 Feedback: opens in its own window from both entry points, metadata includes the correct active engine, success closes and notifies, failure keeps the draft.
- [x] 7.5 Window lifecycle: closing these windows does not affect Manager/Workspace lifecycle or quit the app; `pnpm tsc`/lint and `cargo check` pass.
