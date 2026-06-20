## 1. Backend: open-connections registry

- [x] 1.1 Add a cross-engine open-connections registry in `src-tauri` tracking `{ id, kind, name }` for every open connection, updated at the single choke points where each engine's pool/client is inserted into / removed from its registry (`PgPoolRegistry`, `MysqlPoolRegistry`, `MssqlPoolRegistry`, `DynamoClientRegistry`, `AthenaClientRegistry`). _New `platform/open_connections.rs` with `OpenConnectionsRegistry` (tokio `RwLock<HashMap<Uuid, OpenConnection>>`); `mark_open`/`mark_closed`/`mark_kind_closed` wired at every engine connect/disconnect/disconnect_all site._
- [x] 1.2 Add command `connections_open_list() -> Vec<OpenConnection>` returning the current open set. _Registered in `generate_handler!`; `OpenConnection.id` serialized as hyphenated lowercase Uuid string to match `connections_list`._
- [x] 1.3 Emit a `connections:open-changed` event to all windows on every connect/disconnect, carrying the updated list. _Payload is the full sorted `Vec<OpenConnection>`, emitted via `app.emit` (broadcasts to all windows)._
- [x] 1.4 Make today's per-engine `*:active-changed` events either delegate to, or be superseded by, this single source so there is one truth. _New event added ALONGSIDE the per-engine ones; per-engine events retained until consumers are repointed in task 8.4._
- [x] 1.5 Verify connect → list contains it; disconnect → list drops it; error/eviction paths keep the registry consistent. _`disconnect_all` uses `mark_kind_closed`; `mark_open` skips gracefully on missing row. `cargo check` passes clean._

## 2. Window routing scaffold

- [x] 2.1 Change `tauri.conf.json` so the startup window has label `manager` (keep title "Argus"); remove the assumption of a single static window. _Startup window now labeled `manager`; workspace created at runtime, not declared statically._
- [x] 2.2 Add a backend command to create the `workspace` window on demand via `WebviewWindowBuilder` (stable label `workspace`), and confirm `tauri-plugin-window-state` persists geometry per label for both windows. _`ensure_workspace_window` command (in `platform/open_connections.rs`): creates the `workspace` window if absent, else shows+focuses it. window-state plugin tracks both labels automatically._
- [x] 2.3 In `src/main.tsx`, read `getCurrentWindow().label` and mount `<ManagerApp>` for `manager` and `<WorkspaceApp>` for `workspace`. _`getCurrentWindow().label === "workspace" ? WorkspaceApp : ManagerApp`, inside StrictMode._
- [x] 2.4 Temporary bridge: until phases 3–4 land, render the existing `<Shell>` in both apps so the build stays runnable. _`ManagerApp`/`WorkspaceApp` both render the existing `<App/>` for now, with phase 3/4 TODO markers._

## 3. Manager window

- [x] 3.1 Create `ManagerApp` with its provider subset (Theme, Toast, Updater, Connections, ConnectionGroups, all form providers, ContextEventBus, AiSettings, Palette). No Tabs, no TablePalette. _Deviation: extracted the FULL provider pyramid into `AppProviders` and reused it in both windows (cheaper + safer than divergent subsets); split is at the shell level. `ManagerApp = <AppProviders><ManagerShell/></AppProviders>`._
- [x] 3.2 Extract the connections-list UI from `Sidebar.tsx` / `ConnectionsSection` into the Manager: groups, drag-drop ordering (`useConnectionGroups`, `useExpandedGroups`), the kind picker, create/edit/delete forms, and context-folder linking. _`ConnectionsSection` now exported + accepts `mode`; `ManagerShell` renders `<ConnectionsSection mode="manager"/>`._
- [x] 3.3 Build the Manager connection row from `ConnectionRow.tsx` **without** the inline subtree (header + kind icon + open/closed dot + context menu). Primary action = open in Workspace. _Added non-destructive `mode?: "manager"|"workspace"` prop (default workspace = unchanged). Manager mode: header-only, dot from registry, click = connect + `ensure_workspace_window`, context menu gains "Close connection"._
- [x] 3.4 Render each connection's open/closed state from `connections:open-changed` / `connections_open_list()`. _New `useOpenConnections()` hook (seeds from `connections_open_list`, live-updates from the event); drives the manager dot._
- [x] 3.5 Wire ⌘K and ⌘, for the Manager; ensure ⌘P / ⌥⌘P / ⌘W are inert there. _⌘K/⌘⇧P → palette; ⌘, → local Settings modal; ⌘P/⌥⌘P/⌘W no-op in Manager._

## 4. Workspace window + connection rail

- [x] 4.1 Create `WorkspaceApp` with its provider subset ... and a `focusedConnectionId` store. _`WorkspaceApp = <AppProviders><FocusedConnectionProvider><WorkspaceShell/></...>`; `FocusedConnectionContext` with default-focus-to-first-open logic; `ShellMain` exported and reused._
- [x] 4.2 Build `ConnectionRail` (level 1) ... engine icon + environment-color chip, focused-item styling, name-on-hover, context menu "Close connection", trailing "+". _40px strip; env-color heuristic (prod→warning, else neutral) marked provisional; "+" → `ensure_manager_window`._
- [x] 4.3 On Workspace mount, call `connections_open_list()` to seed the rail; subscribe to `connections:open-changed`. _Via `useOpenConnections()`._
- [x] 4.4 Mount the focused connection's existing per-engine subtree at level 2 ... condition `connectionId === focusedConnectionId`. _Extracted `ConnectionSubtree.tsx` from the inline `ConnectionRow` block; wrapped in `SidebarScrollContext`._
- [x] 4.5 Selecting a rail item sets `focusedConnectionId`; closing from the rail disconnects + moves focus to a neighbor. _Close via per-engine disconnect; default-focus logic re-targets a neighbor._
- [x] 4.6 Rail "+" creates the Manager if absent, else focuses it. _New backend command `ensure_manager_window`._

## 5. Tabs → connection-scoped

- [x] 5.1 Refactor `TabsContext` ... to a map keyed by `connectionId` ...; the visible set follows `focusedConnectionId`. _`Map<connectionId, {tabs, activeTabId}>`; `FocusedConnectionProvider` moved above `TabsProvider` in `AppProviders`; `useTabs()` projects the focused set._
- [x] 5.2 Scope `open`, `close`, `activate`, `move`, `cycle`, `setTabTitle`, `setTabDirty`, and ⌘W to the focused connection's set. _Mutations resolve the owning set by tab id; cycle/⌘W act on the focused set._
- [x] 5.3 Migrate every `openObjectTab` / `open(...)` call site ... to carry the connection scope. _`open()` extracts `connectionId` from payload, else falls back to `focusedConnectionId`; all existing payloads already carry it (query tabs use `initialConnectionId` → fall back to focused). Verified via full test suite._
- [x] 5.4 Extend the "inactive tab content remains mounted" guarantee per connection ... _`TabContent` iterates all sets via `_allSets`, mounts every ever-activated tab, shows only the focused set's active tab._
- [x] 5.5 Remove the `welcome` tab kind; define the per-connection empty state. _`welcome` registration + `BootstrapTabs` removed; empty state reuses the prior "press ⌘K" placeholder._
- [x] 5.6 ... Settings (⌘,) handling in the Workspace (ordinary tab in the focused set) and in the Manager. _Workspace ⌘, opens settings placeholder in focused set (no-op if focused is null); Manager keeps its local Settings modal._

## 6. Coordination + lifecycle

- [x] 6.1 Implement `workspace_open_connection(id)` ... → emit `workspace:focus-connection`. _Engine-agnostic command (ensure window + focus + emit); Manager connects per-engine first, then calls it (idempotent if already open)._
- [x] 6.2 Workspace listens for `workspace:focus-connection` and adds-and-focuses (idempotent). _`WorkspaceLifecycle` listener → `setFocused(id)`; rail entry already present via `useOpenConnections`._
- [x] 6.3 Workspace `close-requested`: **disconnect ALL open connections**, then show/focus Manager (create if closed). _Reworked: `onCloseRequested` preventDefaults, runs `disconnect_all_connections` + `ensure_manager_window`, then `destroy()`. No more warm pools on close._
- [x] 6.4 Manager `close-requested` with a Workspace present: destroy Manager only; Workspace continues. _Rust `RunEvent` CloseRequested(manager): workspace exists → allow close, app stays alive._
- [x] 6.5 Manager `close-requested` with no Workspace: quit on Windows/Linux; macOS keep alive + recreate on dock activation. _`#[cfg(not(macos))] app.exit(0)`; macOS `RunEvent::Reopen` → `ensure_manager_window`._
- [x] 6.6 Empty rail (last connection closed): close the Workspace and focus the Manager. _Single-fire guard (`hasSeenItems` ref) → `ensure_manager_window` + `getCurrentWindow().close()`._
- [x] 6.7 Closing a connection from either window updates both via `connections:open-changed`. _Already wired in Phase 1; both windows subscribe via `useOpenConnections`. No new code._
- [x] 6.8 Backend `disconnect_all_connections()` command: disconnect every open connection across all engines (iterate the open registry / per-engine `disconnect_all`) and emit `connections:open-changed`. Register in `generate_handler!`. _Covers pg/mysql/mssql/athena via `disconnect_all` + dynamo by iterating its registry; single final `connections:open-changed` emit; fault-tolerant._
- [x] 6.9 Workspace close confirmation + disconnect-all: in `onCloseRequested`, read the open count; if **>1**, `preventDefault` and show a native confirm dialog (`dialog` plugin) naming the count — on confirm → `disconnect_all_connections()` + `ensure_manager_window` + close the window; on cancel → leave the window open, connections untouched. If **≤1**, disconnect (if any) + `ensure_manager_window` + close, no prompt. Guard against re-entrancy (a single in-flight close). _`@tauri-apps/plugin-dialog` `confirm` (fallback `window.confirm`); `closingRef`/`itemsRef` guards; `destroy()` to avoid re-trigger; empty-rail effect routes through the same handler._

## 7. ⌘P scoping

- [x] 7.1 Add a `scope: "focused" | "all-open"` input to `useTableIndex()`; filter the index accordingly. _`scopedIds` memo (focused → singleton, all-open → open registry); enumerate loops + eager fan-out bounded to it; system-schema exclusion preserved._
- [x] 7.2 Bind ⌘P → focused scope and ⌥⌘P → all-open scope; ⌘⇧P stays the command-palette synonym. _Coordinator gained `tableScope` + `show(scope)`; `alt`-matching confirmed in `useShortcuts` (no ⌘⇧P collision)._
- [x] 7.3 Show the active scope in the palette header; keep eager fan-out bounded to the scope. _`scopeChip` in `PaletteShell` ("This connection" / "All open connections"), DESIGN.md-restrained._
- [x] 7.4 Verify focus change / connection close updates the open switcher reactively. _`scopedIds` is a dep of the entries memo + eager effect → re-derives on focus/close._

## 8. Cross-window sync + polish

- [x] 8.1 Propagate theme changes to both windows via a Tauri event (mirror `ai-settings-changed`); do not rely on cross-webview `localStorage` events. _`ThemeProvider.setMode` emits `theme-changed` (frontend `emit`, broadcasts to all windows); every window listens and re-applies. Guarded for non-Tauri._
- [ ] 8.2 Confirm AI settings changes reach both windows. _Manual/runtime QA — needs the running app._
- [x] 8.3 Decide and implement status-bar / updater placement (Workspace status bar + Manager footer version). _Already satisfied: Workspace `StatusBar` keeps `VersionIndicator`; Manager footer shows version (Phase 3/4)._
- [x] 8.4 Repoint remaining per-engine `useActiveConnections` consumers at the consolidated open-connections reader. _`TablePalette` membership checks → `useOpenConnections()`. Left places needing engine-specific `ActiveConnection` details (sidebar/row subtree gating, selectors) on per-engine hooks (documented)._
- [ ] 8.5 Design QA against `DESIGN.md`: rail engine icons, environment colors, focused-item treatment, no decorative gradients/bubbly radii; Manager picker and Workspace layout read as one system. _Manual/visual QA — needs the running app (e.g. `/qa-design-review`)._

## 9. Behavioral verification

- [ ] 9.1 Walk every scenario in `specs/dual-window-shell/spec.md` (roles, shared backend, open-list, coordination, lifecycle). _Manual QA — needs the running app._
- [ ] 9.2 Walk every scenario in `specs/connection-rail/spec.md` (rail contents, appearance, focus drives tree/tabs/⌘P, close-from-rail, empty-rail, "+"). _Manual QA — needs the running app._
- [ ] 9.3 Walk the modified `app-shell` scenarios (two windows, per-connection tabs, partitioned shortcuts, focused-only subtree, kind picker in Manager). _Manual QA — needs the running app._
- [ ] 9.4 Walk the modified `table-quick-switcher` scenarios (focused vs all-open scope, reactive scope changes, system-schema exclusion). _Manual QA — needs the running app._
- [x] 9.5 Confirm `pnpm typecheck` and `pnpm lint` are clean; no new console errors in either window. _Final gate: typecheck 0 errors, lint 0 errors (73 pre-existing warnings), 1377/1377 tests pass, `cargo check` clean._

## 10. Design polish — Manager picker + Workspace connection identity (Decisions 10–11)

- [x] 10.1 Manager window default size. _`tauri.conf.json` manager → 760×600, min 520×420; Workspace (`WebviewWindowBuilder`) stays 1280×800/800×500._
- [x] 10.2 Manager picker layout. _`ManagerShell` restyled (prominent header on `--elevated`); manager-mode rows scoped via `data-mode="manager"`: two-line name + host (Geist Mono), engine icon, env + open/closed (`--success`) dots; workspace-mode row untouched. Groups/kind-picker/CRUD preserved._
- [x] 10.3 Inline search field. _Search input at top of the Manager list; `filterQuery` prop threaded to `ConnectionsSection` → filters by name/host/region; "no match" empty state._
- [x] 10.4 Workspace connection identity header. _`ConnectionIdentityHeader` above `ConnectionSubtree` shows focused conn name + engine icon/label + env dot; reuses exported `EngineIcon`/`deriveEnv`/`engineLabel`; reactive on focus change; rail kept compact._
- [x] 10.5 Design QA against `DESIGN.md` (rolls into 8.5). _Self-QA passed (tokens/fonts, single accent, no gradients/bubbly radii). Human visual pass still pending for: Manager header height at 760×600, two-line row rhythm vs group headers, identity-header truncation on narrow widths._
- [x] 10.6 Verify `pnpm typecheck` + `pnpm test --run` + `cargo check`. _typecheck 0 errors · 1377/1377 tests · cargo check clean._

## 11. Rail name label + grouped identity (refinement of Decisions 10–11)

- [x] 11.1 Rail item name label. _Rail widened 40→72px; each item is icon-over-label (`--text-xs`, `--text-subtle`, ellipsis, `title` tooltip kept); env dot + focused stripe/tint adjusted to the new size._
- [x] 11.2 Grouped identity format. _`ConnectionIdentityHeader` shows `"<group> - <connection>"` via `useConnectionGroups` lookup by `group_id`; falls back to just the connection name when no group (or not found); `title` added for truncation._
- [x] 11.3 Verify `pnpm typecheck` + `pnpm test --run` + `cargo check`. _typecheck 0 errors · 1377/1377 tests · cargo check clean._
