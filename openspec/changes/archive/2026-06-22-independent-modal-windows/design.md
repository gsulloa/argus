## Context

Argus runs as a multi-window Tauri 2 app. Windows are created from Rust (`WebviewWindowBuilder`), all load the same `index.html` bundle, and the frontend chooses which React root to mount based on `getCurrentWindow().label` in `packages/app/src/main.tsx`. Today two labels exist: `manager` (declared in `tauri.conf.json`, 760×600) and `workspace` (created on demand by `ensure_workspace_window` in `src-tauri/src/platform/open_connections.rs`).

Two flows are currently rendered as Radix `Dialog` overlays inside whichever window opened them:

- **Connection form** — `modules/<engine>/ConnectionForm.tsx`, opened via per-engine `FormController` providers mounted in `AppProviders`. The kind picker (`ConnectionKindPicker` + `useKindPicker`) calls `<engine>.openCreate()`; edit affordances call `openEdit(initial)`. Rendered as `Dialog.Root`/`Dialog.Portal` (z-index 50/51).
- **Feedback form** — `platform/feedback/FeedbackDialog.tsx`, hosted by `FeedbackHost` (mounted in `ManagerShell` and `App.tsx`), opened via the `argus:feedback:open` window event from the status-bar affordance and the command palette. Rendered as `Dialog.Root`/`Dialog.Portal` (z-index 60/61).

Both overlay inside the compact Manager window and render badly — taller than the 760×600 viewport, controls crowding the chrome. The fix is to host each flow in a right-sized native window.

The capabilities/permissions for window management already exist in `capabilities/default.json` (`core:window:allow-close`, `allow-destroy`, `allow-set-focus`, `allow-show`, `core:event:default`).

## Goals / Non-Goals

**Goals:**
- Present the connection create/edit form and the feedback form in dedicated native windows, sized for their content, fixing the embedded-render defect (#175).
- Reuse the existing label-routing + `ensure_*_window` pattern — no new windowing framework.
- Keep cross-window state correct: the opener's connection list refreshes after a create/edit; the feedback host learns the submission outcome; no duplicate windows.
- Preserve all existing form behavior (fields, validation, diagnostic metadata, attachments, submission, keychain/secret handling).

**Non-Goals:**
- Changing connection storage/registry semantics, feedback backend, or submission payloads.
- Touching the `manager`/`workspace` primary-role model in `dual-window-shell`.
- Reworking the kind picker UX itself (engine choices, ordering) — only where it routes on selection.
- Making these windows multi-instance or persisting their size/position across launches (single-instance focus is enough for v1).

## Decisions

### D1: Native windows routed by label, not a router library

Add two labels — `connection-form` and `feedback` — to `main.tsx`'s label switch, each mounting a dedicated root component (`ConnectionFormApp`, `FeedbackApp`) wrapped in the minimal providers it needs (theme, design tokens, command/keychain access as required), not the full `AppProviders` shell. Rationale: consistent with the existing `manager`/`workspace` mechanism; avoids pulling a client-side router or a second HTML entry point. Alternative considered — a second Vite entry/HTML per window — rejected as more build complexity for no benefit since label routing already works.

### D2: Window creation in Rust via `ensure_*` commands (single-instance)

Add `ensure_connection_form_window` and `ensure_feedback_window` Rust commands mirroring `ensure_workspace_window`: if the labelled window exists, `show()` + `set_focus()` and return; otherwise build it with a content-appropriate `inner_size` / `min_inner_size`, `resizable`, centered. The connection-form window must carry the open intent (create vs. edit, target engine, and for edit the connection id). Rationale: keeps the single-instance + focus logic identical to the proven workspace path.

Passing intent to the window — **decision: pass via an initialization payload the window requests after mount**, rather than encoding it in the URL. The new window, on mount, invokes a `connection_form_intent()` command that returns the pending intent the Rust side stashed when the window was opened (create/edit, engine kind, connection id). Rationale: avoids URL/query coupling and keeps secrets/ids off the address bar; matches the "shared backend, thin frontend" style already used. Alternative — query-string params on `WebviewUrl::App` — workable but leaks the id into the URL and complicates re-focus of an already-open window with a *different* intent.

### D3: Re-focus semantics when a window is already open

For the **feedback** window, re-triggering simply focuses the existing window (idempotent; feedback is stateless across opens). For the **connection-form** window, re-triggering with a new intent (e.g. user clicks "edit a different connection" while the form is open) MUST update the intent and refocus; the simplest correct behavior is: the `ensure_connection_form_window` command updates the stashed intent and emits a `connection-form:intent-changed` event the window listens for to re-prefill, then focuses. For v1, if implementing live intent-swap is risky, the acceptable fallback is to focus the existing window without changing its intent (documented as a known limitation). The spec requires single-instance + focus; live intent-swap is specified as the preferred behavior with the fallback allowed.

### D4: Submit-and-notify via Tauri events

On successful create/update the connection-form window calls the existing `connections.create` / `connections.update` commands (unchanged), then emits a `connections:changed` event (or reuses the existing `connections:open-changed`/list-refresh path the Manager already listens to) so the Manager/Workspace refresh their lists, then closes its own window. On cancel it just closes. The feedback window calls the existing submission command; on success it closes and emits `argus:feedback:submitted` so the host can show the existing success affordance / clear any pending state; on failure it keeps the draft in-window and stays open (matching the current "preserve draft on failure" requirement). Rationale: events are already the cross-window contract (`connections:open-changed`), and the backend commands are unchanged so secret/keychain handling is untouched.

### D5: Remove embedded mounts, keep components

Strip the `Dialog.Root` wrappers' *mount points* from `FormController`/`FeedbackHost`/`ManagerShell`/`App.tsx`, but keep `ConnectionForm` / `FeedbackDialog` field bodies as reusable content rendered inside the new window roots (drop the overlay/portal chrome, render full-window). Rationale: maximal reuse of validated form logic; the only thing changing is the presentation surface.

## Risks / Trade-offs

- **[Lost in-window context for the form]** The embedded form had ambient access to providers (active engine, theme) → Mitigation: pass the needed context explicitly through the intent payload and mount the minimal providers the window root requires; the active-engine value for feedback metadata must be supplied at open time since the feedback window has no ambient connection state.
- **[Stale list if the opener missed the event]** A window opened before the event wiring could miss a refresh → Mitigation: opener refreshes from `connections.list` on receiving the event and also on focus regain; events are emitted to all windows.
- **[Window left orphaned]** If submission throws after the window opened, the user could be stuck → Mitigation: cancel/close is always available; failures keep the window open with the draft intact rather than closing.
- **[macOS lifecycle]** Closing utility windows must not quit the app or affect manager/workspace lifecycle → Mitigation: these are plain transient windows with no lifecycle hooks; only `manager`/`workspace` carry the close-to-quit logic, which is untouched.
- **[Double-open race]** Rapid double trigger could build two windows → Mitigation: the `ensure_*` command checks `get_webview_window(label)` first, same guard as `ensure_workspace_window`.

## Migration Plan

No data migration. Ship as a pure UI/windowing change. Rollback is reverting the frontend mount changes and the two Rust commands; the embedded-dialog code path is removed in the same change, so rollback is a straight revert of the PR. Capabilities additions (`connection-form`, `feedback` labels in `capabilities/default.json`) are additive and safe.

## Open Questions

- Should the connection-form window reuse a single per-app window for all engines (intent carries the engine), or one window per engine? Leaning single window keyed by intent (D2) to keep single-instance focus simple. To confirm during apply.
- Exact `inner_size` defaults per window — to be set against `DESIGN.md` and the real form heights during implementation.
