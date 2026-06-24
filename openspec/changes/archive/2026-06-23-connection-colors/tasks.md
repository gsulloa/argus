## 1. Persistence — schema migration

- [x] 1.1 Add migration `packages/app/src-tauri/migrations/0008_connection_color.sql` with `ALTER TABLE connections ADD COLUMN color TEXT;` (nullable, no default)
- [x] 1.2 Confirm the migration registers in the migrations runner (matches the numbering/loading pattern of `0007_project_source.sql`) and that an existing DB upgrades cleanly with all rows defaulting to `color = NULL`

## 2. Backend — Rust model and commands (`connections.rs`)

- [x] 2.1 Add `pub color: Option<String>` to the `Connection` struct
- [x] 2.2 Add `#[serde(default)] pub color: Option<String>` to `ConnectionInput`
- [x] 2.3 Add a three-state `color: Option<Option<String>>` field to `ConnectionUpdate` reusing the existing `deserialize_*_field` pattern (mirror `context_path`)
- [x] 2.4 Add a `validate_color` helper that accepts only the palette keys (`violet`, `blue`, `green`, `amber`, `red`, `teal`, `pink`, `gray`) or `None`, returning `AppError::Validation` for an unknown key
- [x] 2.5 Update `SELECT_CONNECTION_COLS` to include `color` and update `row_to_connection` to read the new column (mind the positional indices)
- [x] 2.6 Update `create`: validate color, add `color` to the `INSERT` column list and params, and set it on the returned `Connection`
- [x] 2.7 Update `update`: validate color when provided, apply three-state semantics (omit = leave, `Some(Some)` = set, `Some(None)` = clear), add `color` to the `UPDATE` statement, and return the updated value
- [x] 2.8 Verify `move_` and `delete` still round-trip `color` via the shared `SELECT_CONNECTION_COLS`/`row_to_connection` (no separate handling needed)

## 3. Frontend — types and registry API

- [x] 3.1 Add `color: string | null` to the `Connection` interface in `packages/app/src/platform/connection-registry/types.ts`
- [x] 3.2 Add optional `color?: string | null` to `ConnectionInput` and `ConnectionUpdate` (with the same "omit = leave / null = clear" doc comment as `context_path`)
- [x] 3.3 Ensure `packages/app/src/platform/connection-registry/api.ts` passes `color` through `create`/`update` (no transform needed if it forwards the payload)

## 4. Frontend — shared color palette module

- [x] 4.1 Create `packages/app/src/platform/connection-registry/colors.ts` exporting the ordered palette keys, a `CONNECTION_COLORS` constant (key + human label), and a helper resolving a key to its CSS variable name (`--conn-color-<key>`); export a type for the key union
- [x] 4.2 Add the `--conn-color-*` CSS custom properties to the global theme stylesheet for both dark and light themes, sourced from `DESIGN.md` tokens (green=success, amber=warning, red=danger, blue=info, violet=accent; teal/pink/gray tuned for contrast in each theme)

## 5. Frontend — connection form color picker

- [x] 5.1 Build a shared `ColorPicker` component (radio-group semantics, swatch row + "no color" option) consuming the palette from `colors.ts`
- [x] 5.2 Wire the picker into the connection forms: add it to the shared form scaffold in `src/app/ConnectionFormApp.tsx` if one exists, otherwise into each engine form (`postgres`, `mysql`, `mssql`, `dynamo`, `athena`, `cloudwatch`) under `packages/app/src/modules/*/ConnectionForm.tsx`
- [x] 5.3 Prefill the picker from `initial.color` in edit/duplicate mode and default to "no color" in create mode
- [x] 5.4 Include the selected color (key or `null`) in the `create`/`update` payload on submit

## 6. Frontend — render the color

- [x] 6.1 In `ConnectionRail.tsx`, resolve the indicator color as: explicit `conn.color` → its CSS var; otherwise fall back to `deriveEnv(conn.name)`. Drive `.envDot` via the resolved value and keep `deriveEnv` as the documented fallback (verify `useOpenConnections` items expose `color`; thread it through if not)
- [x] 6.2 Update `ConnectionRail.module.css` so the dot can render an arbitrary palette color (e.g. via inline CSS var or a `data-color` attribute selector) while preserving the existing prod/neutral fallback styling
- [x] 6.3 In `ConnectionRow.tsx`, render a small color swatch adjacent to the engine icon when `connection.color` is set; render nothing (current layout) when it is null
- [x] 6.4 Add the swatch styling to `Sidebar.module.css`, ensuring it does not displace the active/connected dot, RO badge, or focused-row stripe

## 7. Verification

- [x] 7.1 Build the Rust backend (`cargo build`/`cargo check`) and run any `connections.rs` unit tests; add/adjust tests covering create-with-color, update three-state color, and invalid-key rejection
- [x] 7.2 Type-check and build the frontend; confirm no `Connection` consumers break on the new field
- [x] 7.3 Manual QA: create a connection with a color, edit it to another color, clear it; confirm the rail dot and sidebar swatch reflect each state and persist across app restart
- [x] 7.4 Verify dark and light themes against `design/preview.html`; confirm restraint (small dots/swatches only, no competing fills) per `DESIGN.md`
- [x] 7.5 Confirm an existing pre-migration database upgrades with all connections defaulting to "no color" and unchanged rail behavior (prod-name heuristic still applies)
