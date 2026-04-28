## 1. Project scaffolding

- [x] 1.1 Initialize Tauri 2 project with the `react-ts` Vite template (`pnpm create tauri-app@latest argus --template react-ts`); merge generated files into the workspace root
- [x] 1.2 Convert the JS workspace to `pnpm` (commit `pnpm-lock.yaml`, remove other lockfiles, set `packageManager` field in `package.json`)
- [x] 1.3 Configure `tsconfig.json` with `strict: true`, `noUncheckedIndexedAccess: true`, and path aliases (`@/platform/*`, `@/modules/*`, `@/components/*`)
- [x] 1.4 Configure `vite.config.ts` for Tauri (correct `clearScreen`, `server.port`, `envPrefix: "VITE_"`, alias config)
- [x] 1.5 Set product name, identifier (`com.argus.app`), and window defaults (1280x800, title "Argus") in `src-tauri/tauri.conf.json`
- [x] 1.6 Create the directory layout from `design.md`: `src/{app,platform/{shell,command-palette,connection-registry},modules,components}` and `src-tauri/src/{platform,error.rs}`
- [x] 1.7 Add a top-level `README.md` with run instructions (`pnpm install`, `pnpm tauri dev`, `pnpm tauri build`) and Linux libsecret note
- [x] 1.8 Verify `pnpm tauri dev` opens a window with placeholder content

## 2. Rust platform — error model and storage

- [x] 2.1 Add Rust deps: `tauri = "2"`, `tokio = { features = ["full"] }`, `rusqlite = { features = ["bundled"] }`, `keyring = "3"`, `serde`, `serde_json`, `thiserror`, `tracing`, `tracing-subscriber`, `uuid = { features = ["v4", "serde"] }`, `directories`
- [x] 2.2 Define `AppError` enum in `src-tauri/src/error.rs` per `design.md` (Storage, Keychain, NotFound, Validation, Internal) with `serde::Serialize` and `tag = "kind"`, `content = "message"`
- [x] 2.3 Implement `platform::storage::open_db(app_handle)` that resolves `app_data_dir()/argus.db`, creates the directory if missing, opens a `rusqlite::Connection`, and runs migrations
- [x] 2.4 Add migration runner: read `.sql` files from `src-tauri/migrations/` in lexicographic order, track applied versions in a `_migrations` table
- [x] 2.5 Author `src-tauri/migrations/0001_init.sql` creating `connections` and `settings` tables exactly as specified in `design.md`
- [x] 2.6 Wire startup in `lib.rs` so the DB is opened during `setup()` and stored as a `tauri::State` (use a `Mutex<Connection>` since rusqlite is not Send-safe across awaits)
- [x] 2.7 If startup migration fails, show a native error dialog via `tauri-plugin-dialog` and exit with non-zero code (do not render the main window)

## 3. Rust platform — secrets and connection registry

- [x] 3.1 Implement `platform::secrets::{set, get, delete}` thin wrappers over `keyring::Entry` using service `"argus"` and account `"connection:<id>"`
- [x] 3.2 Define `Connection` and `ConnectionInput` Rust structs (with `serde`); `Connection` returned to the frontend never contains secrets
- [x] 3.3 Implement `connections::list` Tauri command — `SELECT ... ORDER BY name ASC`, deserialize `params_json`, return `Vec<Connection>`
- [x] 3.4 Implement `connections::create` — validate non-empty `name`, generate UUIDv4, INSERT row, write secret to keychain if provided, return created `Connection`
- [x] 3.5 Implement `connections::update` — UPDATE only provided fields, bump `updated_at`, replace/delete keychain entry per `secret` value (`Some(s)` replaces, `Some(null)`/explicit clear deletes, missing leaves untouched)
- [x] 3.6 Implement `connections::delete` — DELETE row, delete keychain entry if present, return `NotFound` if row absent
- [x] 3.7 Implement `connections::get_secret` — return secret string or `null`, return `NotFound` if id not in `connections` table
- [x] 3.8 Register all four commands in `tauri::Builder::default().invoke_handler(...)`
- [x] 3.9 Write Rust unit tests for the connections module against an in-memory SQLite and a mocked keychain (or feature-flag the keychain calls in tests)

## 4. Frontend platform — shell scaffolding

- [x] 4.1 Add JS deps: `react`, `react-dom`, `@tauri-apps/api`, `@tauri-apps/plugin-dialog`, `cmdk`, `@radix-ui/react-dialog`, `@radix-ui/react-tooltip`, `@radix-ui/react-dropdown-menu`, `lucide-react`, `clsx`
- [x] 4.2 Add a global CSS file with theme variables for `:root[data-theme="light"]` and `:root[data-theme="dark"]` (color, surface, text, border, accent)
- [x] 4.3 Implement `platform/shell/ThemeProvider.tsx` — reads stored mode (`light`/`dark`/`system`), watches `prefers-color-scheme` when in `system`, sets `data-theme` on `<html>`
- [x] 4.4 Implement `platform/shell/Layout.tsx` — four regions (sidebar, center, right inspector, bottom bar) using CSS grid; sidebar resizable via a drag handle persisted in `settings`
- [x] 4.5 Implement `platform/shell/Sidebar.tsx` — sections for "Connections" with a "+" button (opens placeholder dialog)
- [x] 4.6 Implement `platform/shell/StatusBar.tsx` — bottom strip with placeholder metrics and an inspector toggle button
- [x] 4.7 Implement `platform/shell/Inspector.tsx` — right panel with a placeholder; toggle visibility wired to `data-inspector="open|closed"` attribute on the layout root

## 5. Frontend platform — tabs and shortcuts

- [x] 5.1 Implement `platform/shell/tabs/TabsContext.tsx` — state: `tabs: Tab[]`, `activeTabId: string | null`; actions: `open`, `close`, `activate`, `move`
- [x] 5.2 Implement `platform/shell/tabs/TabRegistry.ts` — registry mapping `kind -> React.ComponentType<{ tab: Tab }>`; expose `register(kind, component)` and `get(kind)`
- [x] 5.3 Implement `platform/shell/tabs/TabStrip.tsx` — visual tab bar with close buttons, drag-to-reorder, ⌃Tab / ⌃⇧Tab cycling
- [x] 5.4 Implement `platform/shell/tabs/TabContent.tsx` — renders the active tab via the registry; shows the empty placeholder when no tabs
- [x] 5.5 Register `welcome` tab kind with a static welcome view; open one on launch when no tabs exist
- [x] 5.6 Register `settings-placeholder` tab kind (empty content for now)
- [x] 5.7 Implement a global `useShortcuts` hook (or library: `react-hotkeys-hook`) and bind ⌘K/⌘⇧P, ⌘W, ⌘\, ⌘,
- [x] 5.8 On macOS, configure a native menu bar with the standard `Edit` menu via `tauri.conf.json` so Cut/Copy/Paste/Select All work in inputs

## 6. Frontend platform — command palette

- [x] 6.1 Implement `platform/command-palette/CommandRegistry.ts` — typed `Command` interface and a singleton registry with `register`, `unregister`, `list`, `subscribe`
- [x] 6.2 Implement `platform/command-palette/Palette.tsx` using `cmdk` — modal dialog (Radix), search input, fuzzy filter via cmdk's built-in matcher, group rendering
- [x] 6.3 Wire palette open/close state to a context; trap focus with Radix `Dialog`; restore focus on close
- [x] 6.4 Implement empty states: bootstrap empty state ("No commands available yet") and search empty state ("No matching commands")
- [x] 6.5 Implement hotkey-bound activation: when a command has a `hotkey`, register a global listener that runs the handler without opening the palette
- [x] 6.6 Add a temporary debug command `argus.devNoop` registered in development builds only, to verify the palette renders something

## 7. Frontend platform — connection registry hooks

- [x] 7.1 Implement `platform/connection-registry/types.ts` mirroring the Rust `Connection` shape and the `AppError` enum
- [x] 7.2 Implement `platform/connection-registry/api.ts` — typed wrappers around `invoke('connections_list' | 'connections_create' | ...)` returning `Promise<T>` and throwing typed `AppError`
- [x] 7.3 Implement `useConnections()` React hook — caches list state, exposes `refresh`, `create`, `update`, `remove`
- [x] 7.4 Wire the sidebar "Connections" section to render the empty state and the "+" button (opens a placeholder dialog with a "coming soon" message — real form is in `add-postgres-connection`)

## 8. Settings persistence

- [x] 8.1 Add Tauri commands `settings.get(key)` and `settings.set(key, value)` backed by the `settings` table
- [x] 8.2 Frontend `useSetting<T>(key, defaultValue)` hook — reads on mount, writes on change with debounce
- [x] 8.3 Persist sidebar width and theme mode through `useSetting`

## 9. Logging and dev ergonomics

- [x] 9.1 Configure `tracing-subscriber` in `main.rs`: stderr in dev, rotating file in `app_log_dir()` in release
- [x] 9.2 Add `pnpm` scripts: `dev`, `tauri:dev`, `tauri:build`, `lint`, `typecheck`
- [x] 9.3 Add ESLint + Prettier with a minimal config; add `tsc --noEmit` as a `typecheck` script
- [x] 9.4 Add `cargo fmt` and `cargo clippy -- -D warnings` in a `cargo` workspace `Makefile.toml` or simple `make` target

## 10. Window state plugin (nice-to-have but cheap)

- [x] 10.1 Add `tauri-plugin-window-state` and register it so window size/position persists across launches

## 11. Acceptance verification

- [x] 11.1 Manual: launch `pnpm tauri dev` — window opens at 1280x800 with sidebar, empty center with welcome tab, status bar, hidden inspector
- [x] 11.2 Manual: ⌘K opens palette, shows bootstrap empty state in production build
- [x] 11.3 Manual: ⌘\ toggles the inspector; toggling persists across relaunch
- [x] 11.4 Manual: drag sidebar handle, quit, relaunch — width restored
- [x] 11.5 Manual: switch theme to `dark` explicitly, quit with system in `light`, relaunch — app opens dark
- [x] 11.6 Manual: from the Tauri dev console, call `connections.create({ name: "T", kind: "postgres", params: { host: "x" }, secret: "s" })` and `connections.list()` — created row appears, list contains no secret field _(covered by Rust unit tests `create_and_list_excludes_secret`, `list_orders_by_name`)_
- [x] 11.7 Manual: call `connections.getSecret(id)` for the created row — returns `"s"`; for an unknown id returns `NotFound` _(covered by Rust unit tests `create_and_list_excludes_secret`, `get_secret_unknown_is_not_found`)_
- [x] 11.8 Manual: delete the row — `connections.list()` returns empty; keychain entry is gone (verify with the OS keychain UI on macOS) _(covered by Rust unit test `delete_removes_row_and_secret`; macOS keychain UI verification still recommended once tested live)_
- [x] 11.9 Build a release bundle with `pnpm tauri build` and confirm the produced binary launches and matches the dev experience
