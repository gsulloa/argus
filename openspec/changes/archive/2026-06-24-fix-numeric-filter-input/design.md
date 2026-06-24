## Context

The Postgres data-grid filter bar renders per-row value inputs in `packages/app/src/modules/postgres/data/filter-bar/ValueInput.tsx`. For columns categorized as `numeric` (`typeHelpers.ts` `categorize()`), the scalar and `BETWEEN` inputs render as `<input type="number">` via `inputTypeForCategory()`. The DOM `value` of a `type="number"` input is the empty string whenever its contents are not a parseable number, so typing a comma (the natural gesture for "several IDs") makes `e.target.value === ""`, which then flows through `parseScalar("", "numeric")` → `Number("") === 0` and wipes the field. This is the root cause of in-app feedback #182.

A dedicated `In` / `NotIn` operator already exists for numeric columns and renders a `ChipInput`. It commits a chip on `Enter` or `,` keydown, but it does not handle pasted multi-value text and does not split a single draft into multiple chips — so the "proper" multi-ID path is also awkward for the natural paste gesture.

The backend contract is already accommodating: "Type-aware structured filter parameter binding" states numeric inputs MAY arrive as `JsonValue::String` and MUST be range-checked before binding. So the frontend is free to keep numeric drafts as strings without breaking SQL compilation or parameter binding.

## Goals / Non-Goals

**Goals:**
- Numeric/date single-value inputs never silently discard typed characters.
- The `In`/`NotIn` chip input splits comma/whitespace/newline-separated typed or pasted text into individual chips.
- No change to the filter wire shape, SQL compilation, or backend binding.

**Non-Goals:**
- Auto-converting a `=` row with a comma list into an `In` row (magical operator switching) — explicitly rejected below.
- Reworking the operator set, the filter-bar layout, or persistence.
- Changing how non-numeric (text) value inputs behave — they are already plain text.
- Locale-aware decimal separators.

## Decisions

### Decision 1: `type="text"` + `inputMode`, not `type="number"`
Replace `inputTypeForCategory("numeric") → "number"` with `type="text"` plus an `inputMode` hint (`numeric` for integer-family categories, `decimal` for fractional). This stops the browser from emptying the field on invalid input while still surfacing a numeric keypad on touch and signalling intent to assistive tech.

- **Why over keeping `type="number"`**: the empty-string-on-invalid behavior is the bug; no amount of onChange handling can recover characters the DOM already dropped.
- **Why over `type="number"` with `step`/`pattern` tweaks**: those do not change the `.value === ""` semantics for invalid content.
- Date inputs (`type="date"`) have an analogous swallowing problem for partial input; for v1 we keep dates as-is unless they exhibit the same reported failure — the report is about integers. (See Open Questions.)

### Decision 2: Keep numeric drafts as strings; coerce only when finite
`parseScalar` already returns the raw string when `Number(raw)` is not finite. The fix is to make the **displayed** value the raw typed text rather than a re-stringified number, so an in-progress `31001,` shows `31001,`. `asScalarStringForDisplay` already returns `String(v)` for scalars, so retaining the raw string as the draft scalar is sufficient. A complete numeric value (`31001`) still coerces to the number `31001`, preserving existing apply/compile behavior.

- **Why**: the backend range-checks numeric strings, so a stray string draft cannot produce a malformed bind — at worst it is rejected with the existing validation message at apply time, not silently mis-applied.

### Decision 3: Split delimited values in `ChipInput` on commit and on paste
Introduce a single `splitValues(raw)` helper that splits on `[,\n\s]+`, trims, and drops empties. Route both the keyboard commit path (`commit()`) and a new `onPaste` handler through it, mapping each fragment through the existing per-category `parseScalar`. `Backspace`-to-remove and existing single-value commit are preserved (a single token splits to a one-element array).

- **Why split on whitespace too**: users paste lists in many shapes (`31001 31002`, newline-separated from a spreadsheet column). Comma-only splitting would mis-handle those.
- **Why a shared helper**: keeps keyboard and paste behavior identical and testable in isolation.

### Decision 4: No magical `=`→`In` operator switching
We considered auto-detecting a comma in a single-value field and switching the operator to `In`. Rejected: silently mutating the operator while the user types is surprising and can produce a different query than intended. Decisions 1–3 already let the user type freely and make `In` pleasant; discoverability of `In` can be revisited separately if feedback persists.

## Risks / Trade-offs

- [A string draft for a numeric column reaches apply and fails backend validation] → Acceptable and pre-existing: the backend returns a clear `AppError::Validation` ("expected integer for column …"); this is strictly better than today's silent wipe. The dirty indicator and apply flow are unchanged.
- [Whitespace-splitting breaks values that legitimately contain spaces] → Only relevant for text `In` chips; numeric/date values never contain internal spaces. For text columns this changes behavior (a pasted `foo bar` would split). Mitigation: split on whitespace only for non-text categories, or document that `In` chips are whitespace-delimited. Resolve in Open Questions.
- [`inputMode="numeric"` still hints "no comma" on mobile keyboards] → Argus is a desktop Tauri app; touch keyboards are not the primary surface, and the field still accepts any character. Low impact.

## Migration Plan

Pure frontend change, no data or schema migration. Ships in a normal release; rollback is a straight revert of `ValueInput.tsx` (and any CSS touch). No persisted state is affected.

## Open Questions

- Should whitespace-splitting in `ChipInput` apply to **text** columns, or only numeric/date? (Leaning: split on comma+newline for all; add whitespace only for numeric/date to avoid breaking multi-word text values.)
- Do date/timestamp single-value inputs exhibit the same swallowing failure worth fixing now, or defer until reported? (Report is integer-only; default to also fixing date inputs since `type="date"` shares the empty-on-partial behavior, but confirm during implementation.)
