## 1. Numeric/date scalar inputs stop swallowing input

- [x] 1.1 In `ValueInput.tsx`, replace `inputTypeForCategory()` so numeric categories return `"text"` (with `inputMode` derived separately) instead of `"number"`; decide date handling per design Open Question (default: also use `"text"` with a date-shaped placeholder, or keep `type="date"` if it does not exhibit the swallowing bug).
- [x] 1.2 Add an `inputModeForCategory()` helper returning `"numeric"` for integer-family numeric categories and `"decimal"` for fractional numeric categories; apply `inputMode` to the scalar input and both `BETWEEN` inputs.
- [x] 1.3 Ensure the scalar `=`/comparison input and both `BETWEEN` inputs display the raw typed text (in-progress strings like `31001,` are preserved) and only coerce to a number when the text parses as finite — confirm `parseScalar` + `asScalarStringForDisplay` already yield this and adjust if the display re-stringifies a coerced number.

## 2. In/NotIn chip input splits delimited values

- [x] 2.1 Add a `splitValues(raw)` helper in `ValueInput.tsx` that splits on commas, newlines, and whitespace runs, trims fragments, and drops empties (scope whitespace-splitting to numeric/date vs text per design Open Question).
- [x] 2.2 Route `ChipInput`'s `commit()` through `splitValues`, mapping each fragment through `parseScalar(fragment, category)` and appending all resulting chips at once.
- [x] 2.3 Add an `onPaste` handler to the chip input that prevents the default paste, runs the clipboard text through `splitValues` + `parseScalar`, and appends the chips (merging with any existing draft text).
- [x] 2.4 Preserve existing single-value commit, the `,`/`Enter` delimiter keys, and `Backspace`-to-remove-last behavior.

## 3. Verification

- [x] 3.1 Manually verify against the issue repro: open a Postgres table with an `int` `id` column, filter `=` and type `31001, 31002` — the field retains the text and is not blanked.
- [x] 3.2 Verify the `In` operator on the same column: pasting `31001, 31002, 31003` produces three chips; applying yields `id IN ($1, $2, $3)` and the query succeeds.
- [x] 3.3 Verify a single numeric value still binds as a number (no `error serializing parameter`) and that text-column filters are unchanged.
- [x] 3.4 Add/adjust unit tests for `splitValues` and numeric `parseScalar` edge cases if the module has test coverage; otherwise note the gap.
