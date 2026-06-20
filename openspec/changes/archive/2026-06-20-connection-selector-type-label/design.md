## Context

The connection selector (`packages/app/src/modules/postgres/sql/ConnectionSelector.tsx`) is a Radix `DropdownMenu` rendered in the Postgres SQL editor toolbar. It draws from `useConnections()`, which returns **all** registered connections regardless of engine, so a single dropdown can mix Postgres, MySQL, MSSQL, DynamoDB, and Athena entries. Today each item renders only a status dot and the connection name; there is no engine icon in this control. A canonical engine-name helper, `engineLabel(kind)`, already exists in `@/platform/shell/ConnectionRail` and is used by the connection rail and the new-connection kind picker.

## Goals / Non-Goals

**Goals:**
- Make each dropdown item self-identify its engine type in plain text.
- Reuse the existing `engineLabel` helper — one source of truth for engine names.
- Stay within the `DESIGN.md` "Watchful Precision" system: neutral, hairline, no extra accent.

**Non-Goals:**
- No engine icon added to the selector (separate, optional follow-up).
- No change to the collapsed trigger button (limited width; would crowd the name).
- No backend, registry, or data-model changes.

## Decisions

- **Reuse `engineLabel(kind)` rather than a local map.** The helper already covers all five engines with the product's preferred display names (`SQL Server`, not `mssql`) and a raw-`kind` fallback for unknown engines. Importing it avoids a second copy that could drift. Trade-off: this couples `ConnectionSelector` to the `ConnectionRail` module, but the import is a pure function and there is no circular dependency (the shell never imports the selector — verified).
- **Right-aligned, muted label (`.itemType`).** Connection name keeps `flex: 1` with ellipsis; the type label gets `flex-shrink: 0` so it never squeezes the name and the name truncates first under width pressure. Styled `--text-subtle`, 10px, no accent — secondary information that does not compete with the name, per the design system's "neutrals + hairlines" rule and the rarity discipline for the violet accent.
- **Dropdown only, not the trigger.** The trigger button is width-constrained in the toolbar; the dropdown is where the user browses and disambiguates, so the label earns its space there.

## Risks / Trade-offs

- [Unknown engine `kind` shows raw value] → Accepted: `engineLabel` already falls back to the raw `kind`, matching existing behavior elsewhere; no engine in the product hits this path.
- [Long type label on a narrow dropdown could wrap or push the name] → Mitigated by `flex-shrink: 0` on the label and `flex: 1` + ellipsis on the name; the name absorbs width pressure, the label stays intact, and the dropdown has `max-width: 280px`.
- [Module coupling to `ConnectionRail`] → Low risk: pure-function import, no cycle. If coupling ever becomes a concern, `engineLabel` can be hoisted to a shared module without behavior change.
