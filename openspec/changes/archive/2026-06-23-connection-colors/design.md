## Context

Argus connections are stored as a generic envelope in SQLite (`connections` table) and mirrored by a TypeScript `Connection` type. The only environment cue today is a **name heuristic** in `ConnectionRail.tsx` (`deriveEnv`: name matches `/prod/i` → amber `--warning` dot, else neutral gray). The source comment explicitly marks this as provisional and asks for "an explicit per-connection field rather than a name heuristic."

This change introduces that explicit field: a user-chosen **color** per connection. It touches the full stack — SQLite migration, Rust model + commands, TS types + API, the per-engine connection forms, and the two places connections are rendered (`ConnectionRail`, `ConnectionRow`). `DESIGN.md` governs the palette: the system is deliberately restrained around a single violet accent and warns against "multiple accent colors competing for attention," so the color set must be a small, fixed, semantically-grounded palette rather than a free hex picker.

## Goals / Non-Goals

**Goals:**
- Let users assign one color (from a fixed palette) to a connection, and clear it back to "no color".
- Persist the color durably and surface it everywhere a connection is listed (rail, sidebar rows).
- Render correctly under both dark and light themes.
- Preserve existing behavior for connections with no color (keep the name heuristic as a fallback so nothing regresses).
- Zero-migration-pain: nullable column, existing rows default to "no color".

**Non-Goals:**
- Per-**group** colors (groups already organize by project; out of scope for v1).
- Free-form / custom hex colors or a full color wheel.
- Automatic/derived color assignment beyond the existing name fallback.
- Color-based filtering or sorting of the connection list.

## Decisions

### Decision 1 — Store a stable color *key*, not a raw hex value

The `color` field stores one of a fixed set of lowercase keys (`violet`, `blue`, `green`, `amber`, `red`, `teal`, `pink`, `gray`) or SQL `NULL` ("no color"). The frontend maps each key to a CSS custom property (`--conn-color-<key>`) defined once per theme, so dark and light render theme-appropriate shades from the same stored value.

- **Why not raw hex?** A stored `#FBBF24` looks right in dark mode and wrong (poor contrast) in light mode, and it would let arbitrary colors in, violating `DESIGN.md`'s restraint. A key decouples *intent* from *rendered shade*.
- **Why these keys?** They reuse the established semantic hues (green=`--success`, amber=`--warning`, red=`--danger`, blue=`--info`, violet=`--accent`) plus teal/pink/gray to reach a usable count of visually-distinct, equally-weighted labels. The palette is curated, not extensible by users.

### Decision 2 — Validation lives in Rust; unknown keys are rejected

`connections.create`/`connections.update` accept `color: string | null`. The backend validates against the known-key allow-list (mirroring `validate_name`'s pattern) and returns `AppError::Validation` for an unknown key. This keeps the stored data clean regardless of which form/client writes it.

- **Alternative considered:** trust the frontend (no backend validation). Rejected — the registry is the system of record and other code paths (context sync, future import) could write bad values.

### Decision 3 — `update` uses two-state (not three-state) semantics for `color`

`context_path`/`project_source_path`/`secret` use a three-state `Option<Option<T>>` (omitted = leave, `Some(None)` = clear, `Some(Some)` = set) because clearing is distinct from leaving. For `color`, the form always sends the current selection (a key or `null`), so a simpler two-state `Option<Option<String>>` is unnecessary — `color: Option<Option<String>>` would still work, but we follow the simplest contract that the form needs: send the field on every save; omitted = leave unchanged, explicit `null` = clear. To match the existing three-state machinery and keep `update` uniform, implement `color` with the same `Option<Option<String>>` deserializer as `context_path`.

- **Why mirror the three-state pattern?** Consistency with the existing `ConnectionUpdate` fields and the ability for non-form callers to omit the field without clobbering it. Low extra cost.

### Decision 4 — The explicit color supersedes `deriveEnv`, which becomes a fallback

In `ConnectionRail`, the indicator dot now resolves as: **explicit color key → its CSS var**; if the connection has no color, fall back to today's `deriveEnv(name)` result (prod=amber, else neutral). `deriveEnv` and its provisional comment stay, but its role is demoted to "fallback for uncolored connections." This keeps existing prod-named connections looking unchanged while letting an explicit choice win.

- **Alternative considered:** delete `deriveEnv` entirely. Rejected for v1 — it would visually regress every existing prod-named connection that hasn't been assigned a color yet.

### Decision 5 — Rendering: a small color dot/swatch, reusing existing affordances

- **Rail:** repurpose the existing `.envDot` element — same size/position, color driven by `data-color` attribute (or inline CSS var) instead of `data-env`.
- **Sidebar row (`ConnectionRow`):** add a small color swatch adjacent to the engine icon (a `data-color` styled element), not a full-row tint, to respect `DESIGN.md`'s anti-"multiple accent colors competing" guidance. The active/focused stripe and connected dot remain unchanged.
- **Form:** a single horizontal swatch row (radio-group semantics) with a "none" option; reuses existing form styling tokens.

### Decision 6 — Shared color definitions in one place

Define the key→CSS-var map and a `CONNECTION_COLORS` constant (keys + display labels) once in a shared frontend module (e.g. `src/platform/connection-registry/colors.ts`) consumed by the rail, the row, and every engine form, so the palette is single-sourced. The CSS variables themselves live in the global theme stylesheet alongside the existing `--success`/`--warning` tokens.

## Risks / Trade-offs

- **[Light-mode contrast]** Some hues (amber, green) need darker shades in light mode to stay legible against `--canvas` `#FAFAF9`. → Define each `--conn-color-<key>` per theme using the already-tuned light-mode semantic values from `DESIGN.md` (e.g. `--warning` light = `#D97706`).
- **[Palette overload vs. DESIGN restraint]** Introducing 7 colors risks the "multiple accent colors competing" anti-pattern. → Constrain rendering to small dots/swatches only (no row backgrounds, no large fills); colors are identifiers, never CTAs. Flag in design review.
- **[Per-engine form duplication]** There are six `ConnectionForm.tsx` files. Adding the picker to each invites drift. → Extract the picker as one shared component and drop it into each form's shared scaffold; if a shared field layout exists in `ConnectionFormApp.tsx`, host it there.
- **[Migration on older DBs]** A failed migration blocks startup (per `connection-registry`). → The migration is a single additive `ALTER TABLE ... ADD COLUMN color TEXT` with no default backfill needed; lowest-risk migration shape.

## Migration Plan

1. Add migration `0008_connection_color.sql`: `ALTER TABLE connections ADD COLUMN color TEXT;` (nullable, no default).
2. Extend Rust `Connection`, `ConnectionInput`, `ConnectionUpdate`, `row_to_connection`, `SELECT_CONNECTION_COLS`, and the `create`/`update` SQL to read/write `color`.
3. Extend TS `Connection`/`ConnectionInput`/`ConnectionUpdate` and the registry API.
4. Add shared `colors.ts` + theme CSS vars; wire the picker into the forms and the indicator into rail + row.
5. Rollback: the column is additive and nullable; reverting the app code leaves the column unused and harmless. No data backfill to undo.

## Open Questions

- Final palette size and exact hue list (7 proposed) — confirm during design review against `design/preview.html`.
- Whether to also show the color on open-connection **tabs** / the focused-connection identity header — deferred; rail + sidebar cover the issue's need, tabs can follow if desired.
