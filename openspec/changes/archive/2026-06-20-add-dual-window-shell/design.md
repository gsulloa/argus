## Context

Argus is a Tauri 2 desktop app. Today it is **single-window** (`tauri.conf.json` declares one static window). The React frontend (React 18, Context API — no Redux/Zustand) boots into `App.tsx`, which wraps a `<Shell>` with a deep provider stack: `ThemeProvider`, `ToastProvider`, `UpdaterProvider`, `PaletteProvider`, `TabsProvider`, `ConnectionGroupsProvider`, `ConnectionsProvider`, `AiSettingsProvider`, `ContextEventBusProvider`, and per-engine form providers.

The **backend is already shared, multi-window-ready state**: `app.manage(...)` holds `DbState` (SQLite), `PgPoolRegistry`, `MysqlPoolRegistry`, `MssqlPoolRegistry`, `DynamoClientRegistry`, `AthenaClientRegistry`, and `ContextRegistry`. Commands are invoked per-window but resolve against these shared registries, and the backend already emits Tauri events (`postgres:active-changed`, `ai-settings-changed`, `context://changed`). So two windows can reuse one connection pool with no coordination beyond the events.

Two existing couplings make the current sidebar do double duty:

1. **`ConnectionRow.tsx:733-798`** renders a connection's header *and* its schema subtree inline, gated on a per-engine `useActiveConnections().isActive(id)`. "Active" means "has an open session" — and multiple can be active at once. That is exactly why all trees stack up (#146).
2. **`useTableIndex.ts`** aggregates relations across *all* active connections with no notion of a single focused one (#147).

The missing primitive in both is a **focused connection**: exactly one, distinct from "open." This design makes focus structural by giving it its own OS window and a rail, rather than threading a `focusedConnectionId` flag through a single window. (The single-window flag approach was the smaller alternative — see Decision 1.)

## Goals / Non-Goals

**Goals**

- Two windows with fixed roles: a Connection **Manager** (picker + all CRUD) and a single **Workspace** (rail + focused connection's tree + tabs).
- The Workspace shows exactly one connection's tables at a time (closes #146) and ⌘P defaults to that connection (closes #147).
- A single, backend-owned source of truth for "which connections are open" that both windows agree on.
- Reuse the existing per-engine schema subtrees, the existing tab renderers, and the shared backend registries — this is a re-composition, not a rewrite of the data layer.
- Preserve per-window geometry across launches via the existing `tauri-plugin-window-state`.

**Non-Goals**

- **Multiple Workspace windows.** Exactly one Workspace; the rail rotates focus. (Explicitly decided.)
- **Persisting open connections or tabs across app restarts.** Cold start is always clean: Manager only, nothing connected. (Explicitly decided.)
- **A "search everything across windows" experience.** ⌘K (commands) and ⌘P (tables) stay within the window that owns them.
- **Reworking connection CRUD, groups, or context folders.** Their behavior is unchanged; only their host window moves.
- **CloudWatch focus semantics beyond what other engines get** — it rides the same rail/registry as everything else.

## Decisions

### Decision 1: Two OS windows from one bundle, routed by window label

Both windows load the same `index.html`. `main.tsx` reads the current window's label (`getCurrentWindow().label`) and mounts either `<ManagerApp>` or `<WorkspaceApp>`, each with its own provider subset. The Manager is created at startup (declared in `tauri.conf.json` with label `manager`); the Workspace is created on demand via `WebviewWindowBuilder` with label `workspace`.

**Why:** One bundle keeps build, theming, and IPC identical across windows. Label-based routing is the standard Tauri multi-window pattern and lets `tauri-plugin-window-state` persist each window's geometry by its stable label. A URL hash (`#/workspace`) was considered but the label is already authoritative and survives reloads.

**Provider split:**

| Provider | Manager | Workspace |
|---|---|---|
| Theme, Toast | ✅ (synced, see D8) | ✅ (synced) |
| Updater | ✅ | — (status bar lives in Workspace too; see open questions) |
| ConnectionsProvider, ConnectionGroupsProvider | ✅ | read-only lookup for rail labels |
| Connection form providers (PG/MySQL/MSSQL/Dynamo/Athena) | ✅ | — |
| ContextEventBus | ✅ (folder linking UI) | ✅ (docs/AI grounding) |
| AiSettingsProvider | ✅ ("Configure providers") | ✅ (chat panel) |
| PaletteProvider (⌘K) | ✅ | ✅ |
| TablePalette (⌘P) | — | ✅ |
| Tabs (connection-scoped) | — | ✅ |

### Decision 2: A single Workspace window; the rail rotates focus

There is at most one Workspace window. Its left **rail** lists the currently-open connections; the selected one is the focused connection. This is the TablePlus model from the reference screenshot (the vertical icon strip), and matches the explicit decision against N windows.

### Decision 3: A backend-owned "open connections" registry is the cross-window source of truth

Add a cross-engine registry in Rust tracking the set of open connection ids (with `kind` and `name`), populated as any engine connects/disconnects. Expose:

- `connections_open_list() -> Vec<OpenConnection>` — what is currently open.
- Event `connections:open-changed` — emitted to **all** windows on every connect/disconnect, carrying the new list.

The Manager renders open/closed dots from this; the Workspace builds its rail from this. On Workspace spawn it calls `connections_open_list()` to rebuild the rail (so a freshly spawned Workspace shows every already-open connection, not just the one just opened).

**Why:** Two separate webviews do not share React state or reliably share `localStorage` change events. The pools already live in Rust, so "is it open" is most truthfully answered there. This consolidates today's per-engine `*:active-changed` events into one cross-engine signal; per-engine `useActiveConnections` hooks become thin readers of it (or are replaced).

**Alternatives considered:** (a) Frontend-to-frontend via `emit`/`listen` between windows — rejected: fragile ordering, and the Workspace still needs the full open set on spawn. (b) Keep per-engine events and union them in each window — rejected: every window would re-implement the union and they could drift.

### Decision 4: `focusedConnectionId` is Workspace-local and drives three things

The Workspace holds one piece of state — `focusedConnectionId` — set by clicking a rail item. It drives:

1. **Level 2 schema tree**: only the focused connection's subtree mounts.
2. **The visible tab set** (Decision 5).
3. **⌘P default scope** (Decision 6).

When the focused connection is closed, focus moves to the neighbor in the rail; when the rail empties, the Workspace closes (Decision 7).

### Decision 5: Tabs become connection-scoped

`TabsContext` changes from one flat `{ tabs, activeTabId }` to a map keyed by `connectionId`, each holding its own `{ tabs, activeTabId }`. The visible set is the one for `focusedConnectionId`. `open(...)`, `close`, `cycle`, `setTabTitle`, `setTabDirty`, and ⌘W operate on the focused connection's set. Switching the rail swaps the visible tab strip without unmounting the other sets (the existing "inactive tab content remains mounted" guarantee extends per-connection).

Tabs that are **not** tied to a connection (the old `welcome` tab, the `settings-placeholder` tab) are reconsidered:

- The **welcome** tab is removed — the Manager *is* the welcome surface.
- **Settings** (⌘,) is an app-level concern. It opens in the focused connection's tab set as an ordinary tab in the Workspace, and is also reachable from the Manager. (See open questions for the "no Workspace yet" edge.)

**Why:** Keeping tabs flat and filtering by connection at render time was the alternative; it leaks the focus condition into every tab consumer and breaks ⌘W/cycle semantics ("close the active tab" must mean *within this connection*). A keyed map makes the scope structural.

### Decision 6: ⌘P focused by default; a modifier searches all open connections

`useTableIndex()` gains a `scope: "focused" | "all-open"` input. Default ⌘P opens the switcher with `scope: "focused"` — the index contains only the focused connection's relations. A modifier opens it with `scope: "all-open"` — the current cross-connection behavior, now bounded to *open* connections.

**Hotkey choice:** ⌘⇧P is already a synonym for ⌘K (command palette), so it cannot mean "global tables." Proposed: **⌥⌘P** (Option/Alt+Cmd+P) opens the all-open table switcher. The open palette also shows a scope indicator (focused ↔ all) so the distinction is visible and, if we choose, toggleable in place. Final modifier is an open question for design taste.

**Why:** This is the literal ask in #147 ("default to the active connection, keep an explicit global option"). Scoping the *default* to the focused connection is the part that removes the cross-connection noise.

### Decision 7: Window lifecycle via `close-requested` handlers + the open registry

| Event | Behavior |
|---|---|
| Cold start | Create `manager` only. No Workspace, nothing connected. |
| Manager: open connection (first) | `workspace_open_connection(id)` connects if needed, creates `workspace`, focuses it, emits `workspace:focus-connection`. |
| Manager: open connection (already open) | Same command; Workspace already exists → focus it + emit `workspace:focus-connection` so the rail selects it. No duplicate rail entry. |
| Workspace `close-requested` | **Disconnect ALL open connections**, then show/focus the Manager (create it if it was closed). If **>1** connection is open, first show a confirmation prompt naming the count; cancel aborts the close (window stays, connections untouched). With ≤1 open, close without a prompt. |
| Manager `close-requested`, Workspace exists | Destroy the Manager only; Workspace stays. Rail "+" recreates/focuses the Manager. |
| Manager `close-requested`, no Workspace | Quit the app (the home with nothing else open). macOS may keep the process alive per platform convention; reopen recreates the Manager. |
| Close last connection in rail | Disconnect → registry hits 0 → Workspace closes itself and focuses the Manager (no prompt — already zero open). |
| Close a connection (rail right-click **or** Manager) | Disconnect that connection; both windows update from `connections:open-changed`. If it was focused, focus moves to a neighbor. |

**Why disconnect-on-close (revised):** the Workspace is the active working surface; closing it is treated as "I'm done with these connections," so all pools are released rather than left warm. Because closing can drop several live sessions at once, a confirmation prompt guards the multi-connection case (>1). The prompt is shown via the OS/native dialog (`dialog:default` capability) from the `close-requested` handler, which `preventDefault`s until the user decides; on confirm the handler disconnects all and closes, on cancel it returns without closing. Disconnecting every open connection across engines is done by a single backend `disconnect_all_connections()` command (iterating the open-connections registry / per-engine `disconnect_all`), which emits `connections:open-changed` so the Manager reflects the now-empty state.

### Decision 8: Cross-window UI state syncs via Tauri events, not shared storage

Theme and AI settings must look consistent in both windows. AI settings already emit `ai-settings-changed`. Theme changes (today persisted + applied via `data-theme`) get the same treatment: a `theme-changed` event (or a small settings-changed event) that both windows listen to, re-reading the persisted value and re-applying `data-theme`. We do not rely on `localStorage` `storage` events firing across separate webviews.

### Decision 9: Decouple header from subtree in the connection-row UI

The current `ConnectionRow` (header + inline `useActiveConnections`-gated subtree) splits into:

- A **Manager row**: header, environment/kind glyph, open/closed dot, primary action = "open in Workspace", context menu (edit, link folder, close, delete). No subtree.
- A **Workspace subtree host**: mounts the existing per-engine subtree component (`SchemaTree` / `MysqlSchemaTree` / `MssqlSchemaTree` / `DynamoConnectionSubtree` / `AthenaSchemaTree`) for `focusedConnectionId` only.

The per-engine subtree components themselves are reused unchanged; only their mount condition changes from "this row is active" to "this connection is focused in the Workspace."

### Decision 10: The Manager is a purpose-built picker, not a transplanted sidebar (design polish)

The first Manager implementation reused `ConnectionsSection` (the sidebar list) inside a full-height column in a 1280×800 window. That reads as "the sidebar, but huge." The Manager is the app's home/launcher, so it should look like a deliberate connection *picker* (TablePlus's welcome window is the baseline to surpass), within the `DESIGN.md` system.

- **Window sizing:** open at a compact, picker-appropriate default (target ≈ 760×600, min ≈ 520×420) rather than the workspace-sized 1280×800. Geometry still persists per label via `tauri-plugin-window-state`.
- **Presentation:** a scannable connection list with comfortable widths — each row shows the engine icon, connection **name** (primary, Geist `--text-md`), host/subtitle (`--text-subtle`, mono for host), environment indicator, and open/closed state. Groups remain. The cramped sidebar density (`--text-sm`, hover-only affordances) is relaxed for a launcher context.
- **Tokens:** `--surface`/`--elevated` surfaces, `--accent` only for focus/active, 1px `--border` hairlines, no decorative gradients (logo excepted). Reuse existing CRUD/kind-picker/group flows — this is presentation/layout/sizing, not new connection logic.

**Why not a brand-new component tree:** the connection data, groups, kind picker, and CRUD already work via `ConnectionsSection`/`ConnectionRow` (manager mode). The polish is layout, spacing, widths, and window size — keep the logic, restyle the container and rows for a launcher.

### Decision 11: The Workspace shows the focused connection's identity, not just its engine icon (design polish)

The rail communicates engine (icon) + environment (dot) but the **name** is only on hover, so the user can't tell *which* Postgres/Dynamo they're in at a glance. The focused connection's identity MUST be legible without hover.

- **Primary fix:** a connection-identity header at the top of the Workspace level-2 column (above the schema tree) showing the focused connection's **name** + engine + environment. This is the lowest-risk, highest-legibility option and gives the name real estate the 40px rail lacks.
- **Rail affordance:** keep the compact icon rail, but ensure each item exposes the name reliably (tooltip) and the focused item is unmistakable; optionally a 1–2 char/abbreviation hint is out of scope unless the header proves insufficient.

**Why a header over widening the rail:** widening the rail to fit names trades away the compact TablePlus-style strip the user liked; a header places the full name where there's room and scales to long names/hosts.

**Refinement (Phase 11):** per follow-up feedback the rail now ALSO shows the connection name in a small `--text-xs` label beneath each icon (truncated + tooltip), so the rail itself is identifiable at a glance — the rail widens modestly from a pure icon strip to icon+label. And the identity header's name is formatted `<group> - <connection>` when the connection belongs to a group (just `<connection>` otherwise), so the user sees both the grouping and the specific connection.

## Risks / Trade-offs

- **Tabs refactor blast radius** — every `openObjectTab`/`open(...)` call site (sidebar clicks, ⌘P, AI "open result", query-from-doc) must pass/derive a connection scope. *Mitigation:* land the connection-scoped `TabsContext` first with a shim that defaults to the focused connection, then migrate call sites; keep the "inactive content stays mounted" guarantee per connection.
- **Cross-window focus thrash** — opening an already-open connection must focus the existing Workspace and select its rail item without flicker or duplicate rail entries. *Mitigation:* rail entries are keyed by connection id; `workspace:focus-connection` is idempotent.
- **Window-state plugin labels** — geometry persistence is keyed by window label; the Workspace is created at runtime, so it must use a stable label (`workspace`) for geometry to persist. *Mitigation:* fixed labels, documented.
- **macOS "no windows" convention** — quitting on Manager-close-with-no-Workspace differs from macOS norms (apps stay alive). *Mitigation:* on macOS keep the process alive and recreate the Manager on dock activate; on Windows/Linux quit. Spec leaves the platform nuance explicit.
- **New backend registry correctness** — the open-connections registry must stay in lockstep with the per-engine pool registries (connect/disconnect/eviction/errors). *Mitigation:* update it at the single choke points where pools are inserted/removed; emit on every mutation; the Workspace re-syncs via `connections_open_list()` on spawn.
- **Updater/status-bar placement** — today the status bar (version + pending update) lives in the single shell. With two windows it must have a clear home. *Mitigation:* status bar lives in the Workspace; the Manager shows version in its footer. (Open question.)
- **Per-engine `useActiveConnections` consumers** — several places read per-engine "active" state. *Mitigation:* repoint them at the consolidated registry reader to avoid two sources of truth.

## Migration Plan

Phased, each phase independently testable:

1. **Backend open-registry**: add the cross-engine registry, `connections_open_list()`, and `connections:open-changed`; wire it at pool insert/remove. No UI change yet.
2. **Window routing scaffold**: `main.tsx` label routing; `WebviewWindowBuilder` for `workspace`; `tauri.conf.json` startup window = `manager`. Behind this, temporarily render the existing Shell in both to keep the app runnable.
3. **Manager window**: extract the connection-list/groups/kind-picker/forms/context-linking into `ManagerApp`; remove the inline subtree from its rows.
4. **Workspace window**: `ConnectionRail` + `focusedConnectionId`; mount the focused connection's existing subtree at level 2.
5. **Tabs → connection-scoped**: refactor `TabsContext`; migrate call sites; extend the mounted-content guarantee per connection.
6. **Coordination + lifecycle**: `workspace_open_connection`, `workspace:focus-connection`, all `close-requested` rules.
7. **⌘P scoping**: `scope` input on `useTableIndex`; ⌥⌘P (or final modifier) for all-open; scope indicator in the palette.
8. **Cross-window sync + polish**: theme/AI-settings events; status-bar/updater placement; design QA against `DESIGN.md` for the rail (engine icons, environment colors, no decorative slop).

No data migration; no backend schema change beyond the in-memory registry.

## Open Questions

- **Global ⌘P modifier**: ⌥⌘P vs an in-palette scope toggle vs both. Decide once rendered.
- **Settings with no Workspace**: when the user hits ⌘, from the Manager (no Workspace yet), does Settings open as a Manager view or does it spawn the Workspace? Leaning: Manager-local settings view.
- **Updater/status-bar home**: Workspace-only, both windows, or Manager-only? Leaning: Workspace status bar + Manager footer version.
- **Environment color source**: the rail chip color (prod/local) — derived from connection name heuristics (as TablePlus does) or an explicit per-connection field? Leaning: explicit optional field, defaulting to neutral.
- **macOS process lifetime** on Manager-close-with-no-Workspace: keep-alive + dock-reopen vs quit.
