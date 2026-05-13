## 1. Redraw the Postgres icon

- [x] 1.1 Open `src/modules/postgres/icon.tsx` and replace the four-path elephant-squiggle body with an elephant head-and-trunk profile per design.md Decision 2 — one rounded head path filling the upper two-thirds of the 24px viewBox, one curving trunk path sweeping from the lower front of the head down toward the bottom edge with a small upward tip flick, and one tiny `<circle>` (≤1px radius, `fill="currentColor"`) for the eye.
- [x] 1.2 Keep `viewBox="0 0 24 24"`, `stroke="currentColor"`, `strokeWidth={1.5}`, `strokeLinecap="round"`, `strokeLinejoin="round"`, `fill="none"` on the root `<svg>`. Do not introduce any hardcoded color, gradient, or duotone.
- [x] 1.3 Keep the component signature `export function PostgresIcon({ size = 16, className }: IconProps)` and keep `role="img"` with `aria-label="Postgres"` on the root `<svg>`. Do not add new props.
- [x] 1.4 Update the JSDoc comment above the component to describe the new head-and-trunk silhouette and the shape-category contract (organic rounded blob, not geometric).

## 2. Redraw the Dynamo icon

- [x] 2.1 Open `src/modules/dynamo/icon.tsx` and replace the rounded-rectangle + bisector + hash-marks composition with a stacked-cylinder database glyph per design.md Decision 3 — top ellipse for the cylinder lid, two bottom-half "layer" arcs at roughly 1/3 and 2/3 height, two vertical side-wall lines from the lid ends to the bottom arc, and a closing bottom arc. All shapes `fill="none"`.
- [x] 2.2 Keep `viewBox="0 0 24 24"`, `stroke="currentColor"`, `strokeWidth={1.5}`, `strokeLinecap="round"`, `strokeLinejoin="round"` on the root `<svg>`. Do not introduce any hardcoded color, gradient, duotone, or AWS-branded shape.
- [x] 2.3 Keep the component signature `export function DynamoIcon({ size = 16, className }: IconProps)` and keep `role="img"` with `aria-label="DynamoDB"` on the root `<svg>`. Do not add new props.
- [x] 2.4 Update the JSDoc comment above the component to describe the new stacked-cylinder silhouette and explicitly note the shape-category contract (horizontally-banded geometric, not organic).

## 3. Balance the two marks against each other

- [x] 3.1 Confirm both SVGs occupy roughly the same bounding box inside the 24px viewBox (≈16×16 of mass each) so neither feels visibly heavier than the other at 14px. _Verified: Postgres bounds x=[3, 20], y=[4, 20] (head symmetric around x=12); Dynamo bounds x=[4, 20], y=[3, 20]. Both ≈16–17 units in each axis._
- [x] 3.2 Confirm `stroke-width` is identical (1.5) on both files and that no path on either icon uses a `fill` other than `none` or `currentColor`-on-tiny-detail. _Verified: both files use `strokeWidth={1.5}`; only fill is the 0.7px eye circle (`fill="currentColor"`) on Postgres._

## 4. Visual verification in the real shell

- [ ] 4.1 Run `pnpm tauri dev` (or the project's standard dev command), open the app, and create at least one Postgres connection and one DynamoDB connection so both icon kinds appear adjacent in the sidebar's Connections section.
- [ ] 4.2 At 100% zoom, verify the two sidebar rows (14px icons, `var(--text-muted)`) are distinguishable by silhouette alone — cover the connection-name text with a finger or DevTools and confirm you can still tell which row is which.
- [ ] 4.3 Open the "New connection" kind picker and verify both 20px icons are clearly distinct cards, with the Postgres card showing the elephant profile and the Dynamo card showing the stacked cylinder.
- [ ] 4.4 Toggle the app between dark and light mode and repeat 4.2 and 4.3 — both icons must remain legible against `--canvas` in both modes.
- [x] 4.5 If `design/preview.html` renders the source-kind icons, open it in a browser and confirm the new marks appear correctly there too. _N/A: `design/preview.html` is a static HTML mock that does not import the React `PostgresIcon`/`DynamoIcon` components — no source-kind icons render there to update._

## 5. Quality gates

- [x] 5.1 Run the project's typecheck (`pnpm typecheck` or equivalent) and confirm no new errors. _Verified: `pnpm typecheck` passes._
- [x] 5.2 Run the project's lint (`pnpm lint` or equivalent) and confirm no new warnings on the two changed files. _Verified: `pnpm exec eslint src/modules/postgres/icon.tsx src/modules/dynamo/icon.tsx` reports zero warnings or errors. (The broader `pnpm lint` surfaces 48 pre-existing issues in unrelated files — none in these two.)_
- [x] 5.3 Run the project's test suite (`pnpm test` or equivalent) and confirm no regressions. (No new tests are added for this visual-only change.) _Verified: `pnpm test:run` → 28 test files, 189 tests, all pass._
- [x] 5.4 Run `openspec validate differentiate-db-icons --strict` and confirm the change validates cleanly against its schema. _Verified: change is valid._

## 6. Hand-off

- [ ] 6.1 Commit the two icon files plus the openspec change folder on the current branch with a message that names both files and references the change id `differentiate-db-icons`.
- [ ] 6.2 Open a PR against `origin/master` summarizing: problem (two icons looked too alike at 14px), approach (silhouette redesign, no color), and the two shape categories (organic-elephant vs. stacked-cylinder). Include before/after screenshots of the sidebar with both rows visible at 14px in dark mode.
