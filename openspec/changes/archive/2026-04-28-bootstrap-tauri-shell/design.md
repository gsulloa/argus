## Context

Argus is a greenfield desktop application for inspecting and editing data across multiple sources. V1 targets Postgres exclusively, with the user experience modeled on TablePlus. V2+ will add DynamoDB and CloudWatch as additional data-source modules. This change establishes the platform — the desktop shell, layout patterns, and cross-cutting infrastructure (settings, secrets, persistence) — that every later capability will depend on. No data-source logic is included; the shell ships empty.

The user has decided the high-level stack in advance: Tauri 2 (Rust backend + web frontend) with React + Vite + TypeScript. This document records the design that turns those decisions into a concrete project skeleton, and surfaces the smaller decisions that follow from them.

## Goals / Non-Goals

**Goals:**

- Produce a runnable Tauri 2 desktop app on macOS, Windows, and Linux.
- Establish a four-region layout (sidebar / center tabs / right inspector / bottom status bar) that mirrors TablePlus.
- Provide cross-cutting infrastructure that later changes will plug into: command palette with command registry, connection registry with SQLite + keychain storage, theming, base keyboard shortcuts.
- Define the IPC error model and project layout conventions once, so subsequent changes do not re-litigate them.
- Keep the shell intentionally empty — no commands registered, no connections, no module-specific UI — so that later changes are forced to deliver thin vertical slices.

**Non-Goals:**

- Connecting to any real database (deferred to `add-postgres-connection`).
- Browsing schemas, tables, or any data (deferred to `browse-postgres-schema`, `view-table-data`).
- Editing data, running SQL, query history (later changes).
- SSH tunneling (deferred indefinitely; tracked as a future change).
- Cross-data-source abstractions. The platform is shared chrome only — each data-source module owns its own UI and IPC. There is no `DataSource` trait spanning Postgres / Dynamo / CloudWatch.
- Auto-update, telemetry, crash reporting (later changes if needed).

## Decisions

### Decision: Tauri 2 over Electron

**Choice**: Tauri 2 with Rust backend.
**Rationale**:

- Bundle ~10 MB vs ~150 MB Electron.
- The future modules need Rust-friendly clients (`tokio-postgres`, AWS SDK for Rust) — keeping the backend in Rust avoids language straddling.
- Tauri's IPC + capability model is stricter than Electron's, which reduces the surface area of bugs and security mistakes.
  **Alternatives considered**:
- Electron: faster iteration, larger ecosystem, but bundle size and security model less attractive for a tool that handles credentials.
- Native Swift/SwiftUI: best macOS feel but loses cross-platform portability the user explicitly wants for the team.

### Decision: React + Vite + TypeScript on the frontend

**Choice**: React 18 (or 19 if stable at start), Vite, TypeScript strict mode.
**Rationale**: User preference. React has the most mature data-grid and editor libraries (TanStack Table, CodeMirror integrations), which matters for later changes.
**Alternatives considered**: Solid, Svelte, Vue — all viable, but the data-grid ecosystem skews React.

### Decision: Package manager — pnpm

**Choice**: `pnpm` for the JS workspace.
**Rationale**: Disk-efficient, deterministic, well supported by Tauri tooling. Keeps `node_modules` smaller in dev.
**Alternatives considered**: `npm` (slower, larger), `bun` (fast but Tauri integration less battle-tested).

### Decision: Project layout

```
argus/
├── package.json
├── pnpm-lock.yaml
├── vite.config.ts
├── tsconfig.json
├── index.html
├── src/                            # React frontend
│   ├── main.tsx
│   ├── app/                        # top-level app composition
│   ├── platform/                   # cross-cutting platform UI
│   │   ├── shell/                  # window layout, regions, tabs, theme
│   │   ├── command-palette/        # ⌘K palette + command registry
│   │   └── connection-registry/    # frontend hooks/types for registry
│   ├── modules/                    # data-source modules (empty in V1)
│   └── components/                 # primitive UI atoms
└── src-tauri/                      # Rust backend
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── build.rs
    └── src/
        ├── main.rs
        ├── lib.rs
        ├── error.rs                # shared AppError enum
        └── platform/
            ├── mod.rs
            ├── storage.rs          # SQLite open + migrations
            ├── secrets.rs          # keychain wrapper
            └── connections.rs      # registry commands
```

The `platform/` and `modules/` split is the seam for V2: when DynamoDB arrives, it lands as `src/modules/dynamo/` and `src-tauri/src/modules/dynamo/`. No platform code changes.

### Decision: Persistence — SQLite + OS keychain

**Choice**: SQLite via `rusqlite` (with bundled feature) for non-secret metadata, OS keychain via `keyring` crate for secrets.
**Rationale**:

- SQLite fits the "embedded local store" need with zero deployment burden.
- `rusqlite` + `bundled` avoids a system SQLite dependency on Linux.
- Keychain wrappers (`keyring`) handle macOS Keychain, Windows Credential Manager, and Linux Secret Service uniformly.
- Splitting metadata from secrets means a SQLite file dump never leaks credentials.
  **Alternatives considered**:
- `sqlx` with SQLite: nicer ergonomics, async, but adds compile-time complexity and is overkill for a single-process app.
- Plain JSON file: simpler, but querying history later (sort by recency, search) becomes ugly.
- Encrypted SQLite (SQLCipher): adds build complexity for marginal benefit when secrets are already in keychain.

**Database location**: `app_data_dir()/argus.db` resolved via Tauri's `path` API.
**Migrations**: sequential `.sql` files in `src-tauri/migrations/`, applied at startup, version tracked in a `_migrations` table.
**Initial schema**:

```sql
CREATE TABLE connections (
  id           BLOB PRIMARY KEY,        -- UUID v4 bytes
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,           -- 'postgres' (only kind in V1)
  params_json  TEXT NOT NULL,           -- non-secret connection params
  created_at   INTEGER NOT NULL,        -- unix epoch seconds
  updated_at   INTEGER NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Future changes add columns/tables as needed via new migration files.

**Keychain layout**: service `"argus"`, account `"connection:<uuid>"`, value is a JSON blob. The frontend never receives secrets through list operations.

### Decision: Command palette via `cmdk`

**Choice**: Use the `cmdk` library (Radix-style command menu) for the palette UI; build a thin command-registry context around it.
**Rationale**: Battle-tested, accessible, matches the visual language users expect from VS Code / Raycast / Linear. Avoids re-implementing fuzzy match and keyboard navigation.
**Alternatives considered**: hand-rolling, headlessui — both more work for less polish.

### Decision: UI primitives via Radix UI

**Choice**: Use `@radix-ui/react-*` for dialogs, menus, dropdowns, and tooltips. Style via CSS Modules + CSS variables.
**Rationale**: Radix gives accessibility, focus management, and keyboard handling for free. CSS Modules keep style co-located without a runtime CSS-in-JS cost.
**Alternatives considered**: Mantine / Chakra (too opinionated), Tailwind (fine but adds build step config; can revisit), styled-components (runtime cost).

### Decision: Theming

**Choice**: CSS variables on `:root`, switched by `data-theme="light|dark"` attribute on `<html>`. System preference detected via `matchMedia('(prefers-color-scheme: dark)')`. Setting (`light`/`dark`/`system`) persisted in `settings` table.

### Decision: Tab system state model

**Choice**: Tabs live in a React context within `src/platform/shell/`. A tab has shape `{ id: string, kind: TabKind, title: string, closable: boolean, payload: unknown }`. The `kind` is an open string — the platform does not know about Postgres-specific tabs; modules contribute their own kinds via a renderer registry. In this change only the `welcome` kind exists.
**Rationale**: Keeps platform agnostic of modules. When `view-table-data` is built, it adds a `postgres-table` kind without touching shell code.
**Alternatives considered**: Persisting tabs across launches — nice but deferred until there is anything meaningful to persist.

### Decision: IPC error model

**Choice**: All Tauri commands return `Result<T, AppError>`. `AppError` is a serializable enum:

```rust
#[derive(Debug, thiserror::Error, serde::Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum AppError {
    #[error("storage error: {0}")] Storage(String),
    #[error("keychain error: {0}")] Keychain(String),
    #[error("not found: {0}")]      NotFound(String),
    #[error("validation: {0}")]     Validation(String),
    #[error("internal: {0}")]       Internal(String),
}
```

Frontend has a typed mirror in `src/platform/errors.ts`. Future modules add variants as needed.
**Rationale**: A single shared error type avoids per-command bespoke errors and makes UI error handling uniform.

### Decision: Logging

**Choice**: `tracing` + `tracing-subscriber` on the Rust side, writing to stderr in dev and to a rotating file in `app_log_dir()` in release. Frontend uses `console.*` only (no remote shipping).
**Rationale**: Local tool; no telemetry. File logs help users report issues later.

### Decision: Icons

**Choice**: `lucide-react` icon set.
**Rationale**: Small per-icon footprint (tree-shakable), comprehensive, consistent visual style.

## Risks / Trade-offs

- **Tauri 2 maturity** → Some plugins and docs still mature. Mitigation: pin minor versions, prefer first-party plugins, document any patched issues in `CONTRIBUTING.md` later.
- **Linux keychain (libsecret) dependency** → On bare Linux installs the Secret Service may be missing. Mitigation: detect at startup; if unavailable, surface a clear error and disable connection saving until installed. Document the requirement in the README.
- **Rust compile times slow down dev cycles** → First build is slow; incremental builds are fine. Mitigation: use `cargo` watch in dev; consider `mold`/`lld` as a follow-up.
- **Native menus and clipboard shortcuts on macOS** → Tauri does not auto-wire the standard Edit menu. Mitigation: configure a basic `Edit` menu in `tauri.conf.json` so copy/paste/select-all work in inputs.
- **Frontend over-engineering risk** → Easy to spend a sprint on a design system. Mitigation: ship the smallest viable shell — Radix + CSS variables, no design tokens framework yet.
- **Tab system as a god-object** → Could become a dumping ground for cross-cutting state. Mitigation: keep the tab context strictly about navigation; per-tab payload is opaque to it.

## Migration Plan

Greenfield project — no migration. First `pnpm tauri dev` after this change should open a window with the empty shell. No existing data or users.

## Open Questions

- **React 18 vs 19** — pin to 18 for stability or take 19 if it has shipped stable by start? Default to whatever is stable at implementation time; not load-bearing.
- **macOS code signing / notarization** — out of scope here, but will need addressing before any wider distribution. Track separately.
- **Window state restoration** (size, position, maximized) — nice-to-have; can be deferred to a follow-up. Recommend including via `tauri-plugin-window-state` since it is one line.
