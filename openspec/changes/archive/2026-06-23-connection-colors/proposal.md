## Why

Users who register many connections struggle to tell them apart at a glance — especially distinguishing environments (prod vs. dev/staging) or grouping by project. Today the only environment cue is a fragile name heuristic in the rail (`deriveEnv`: name contains "prod" → amber dot, else neutral). The code itself flags this as provisional and asks for "an explicit per-connection field rather than a name heuristic." This change gives each connection an explicit, user-chosen color so it can be identified instantly in the rail, the sidebar, and tabs.

## What Changes

- Add an optional, user-assigned **color** to every connection, chosen from a small curated palette (semantic tokens: violet/blue/green/amber/red/teal/pink + "no color"). Stored as a stable key, not a raw hex string, so each color renders correctly under both dark and light themes.
- Persist the color: new `color` column on the `connections` table (migration `0008`), threaded through the Rust `Connection`/`ConnectionInput`/`ConnectionUpdate` model and the mirrored TypeScript types and registry API.
- Add a **color picker** (swatch row) to every engine's connection create/edit form.
- Render the color across the shell:
  - **ConnectionRail** — the environment dot becomes the connection-color dot when a color is set.
  - **ConnectionRow** (sidebar, manager + workspace modes) — show a color accent next to the connection.
- Supersede the `deriveEnv` name heuristic: an explicit color is the source of truth; the name heuristic remains only as the fallback for connections with no color assigned, preserving today's behavior for existing data.

Non-goals (v1): per-group colors, free-form hex/custom colors, automatic color assignment.

## Capabilities

### New Capabilities
- `connection-colors`: Defines the curated color palette and its semantic-token mapping, the rules for assigning/clearing a connection's color, persistence semantics, and where/how the color is rendered across the shell (rail, sidebar) including the fallback to the legacy name heuristic.

### Modified Capabilities
- `connection-registry`: The `Connection` model and the create/update/list commands gain an optional `color` field, persisted in the connections table.
- `connection-form-window`: The connection create/edit form gains a color picker for assigning or clearing the connection color.
- `connection-rail`: The environment indicator dot is driven by the explicit connection color when set, falling back to the existing name-based heuristic otherwise.

## Impact

- **Backend (Rust):** `packages/app/src-tauri/src/platform/connections.rs` (model, `row_to_connection`, `SELECT_CONNECTION_COLS`, `create`/`update` SQL); new migration `packages/app/src-tauri/migrations/0008_connection_color.sql`.
- **Frontend types/API:** `packages/app/src/platform/connection-registry/types.ts`, `.../api.ts`.
- **Frontend UI:** `packages/app/src/platform/shell/ConnectionRail.tsx` (+ `.module.css`), `.../ConnectionRow.tsx` (+ `Sidebar.module.css`), the per-engine `ConnectionForm.tsx` files under `packages/app/src/modules/*` (and any shared form scaffold in `src/app/ConnectionFormApp.tsx`).
- **No breaking changes:** the column is nullable; existing connections default to "no color" and keep current rendering behavior.
