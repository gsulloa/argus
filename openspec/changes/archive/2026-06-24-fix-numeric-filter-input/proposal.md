## Why

Filtering an integer column in the Postgres data grid silently destroys what the user types: the value inputs for numeric columns render as `<input type="number">`, and the moment the text stops being a valid single number (e.g. typing a comma to list IDs like `31001, 31002`), the browser reports an empty `value` and the typed digits vanish. Users reading this as "the field resets" (in-app feedback #182) cannot enter the value they want, and the proper multi-value path (the `In` operator) is neither discoverable nor paste-friendly.

## What Changes

- Numeric (and date, where the same swallowing applies) filter value inputs stop using `type="number"`. They render as `type="text"` with `inputMode="numeric"` (or `decimal`) so the input never silently discards characters; the existing `parseScalar` fallback already preserves the raw string when it is not yet a finite number.
- The scalar value input keeps the typed text intact while editing, only coercing to a number when the text parses as one — so an in-progress value like `31001,` is no longer blanked.
- The `In` / `NotIn` `ChipInput` gains **paste-and-type splitting**: pasting or typing a comma-separated list (`31001, 31002, 31003`) splits on commas (and whitespace/newlines) into individual chips instead of committing one junk chip. This makes the multi-ID gesture work where users naturally reach for it.
- A lightweight affordance nudges users toward `In` when they type a comma into a single-value operator's field (decision deferred to design — at minimum, the comma is no longer eaten so they can self-correct).

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `postgres-data-grid`: the filter bar value-input behavior changes — numeric/date scalar inputs must not silently discard non-numeric characters mid-edit, and the `In`/`NotIn` chip input must split comma/whitespace-separated pasted or typed values into multiple chips. The backend filter contract is unchanged (it already accepts numeric values as JSON strings and range-checks them).

## Impact

- Frontend only. No Tauri command, SQL compilation, or parameter-binding changes — the backend already parses numeric filter values arriving as strings (`postgres-data-grid` "Type-aware structured filter parameter binding").
- Affected files: `packages/app/src/modules/postgres/data/filter-bar/ValueInput.tsx` (input `type`, `parseScalar` usage, `ChipInput` paste/commit logic). Possible touch to `FilterBar.module.css` for any new affordance.
- No persisted-state or migration impact; `draft`/`applied` filter shapes are unchanged.
