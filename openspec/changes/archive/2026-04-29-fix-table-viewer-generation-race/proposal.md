## Why

Opening a Postgres table currently leaves the viewer stuck on "Loading table…" for many tables, even though the underlying SELECT completed successfully (the activity-log entry confirms rows were returned and IPC dev-logs show `invoke ←` resolving). Root cause: a race in `useTableData` where the trigger effect captures `state.generation = 0` from the first render's snapshot and passes it to `fetchFirstPage`, but the reset effect — running in the same effect cycle — bumps `generation` to `1`. When the response arrives, the stale-response guard (`stateRef.current.generation !== generation`) silently drops the only fetch, and the spinner never recovers because the trigger effect's guard requires `status === "idle"`. React StrictMode in dev makes this happen twice (two unused fetches), and the bug also fires once in production. The viewer's only escape today is a side-effectful re-render (e.g., changing `pageSize` via the bottom bar, which is what makes the bug feel "intermittent").

## What Changes

- Fix `useTableData` so the first-page fetch is guaranteed to complete its dispatch on a clean mount.
  - Initialize `generation` to `1` in `initialState()` (matching the post-reset value).
  - Make the reset effect idempotent under React 18 StrictMode by comparing the current deps against a fingerprint stored in a ref; the effect only dispatches when the deps actually change. (A single-shot first-mount sentinel was the initial proposal but doesn't survive StrictMode's mount → cleanup → mount effect replay; see `design.md` for details.)
  - Document the invariant inline so the next reader doesn't ask "why does this start at 1?".
- Stand up frontend test infrastructure (Vitest + React Testing Library + jsdom) so this regression — and future hook regressions — are caught before merge. The repo currently has zero `*.test.*` files.
- Add a regression test that mounts the data viewer hook under `<React.StrictMode>` with a mocked `dataApi.queryTable` and asserts the status transitions to `"ready"` and rows are populated.

No user-facing API or Tauri-command contract changes. No `postgres_query_table` Rust changes.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `postgres-data-grid`: add an explicit requirement that the viewer's data-loading state machine guarantees a deterministic `loading-first → ready | error` transition on first mount, with no dependency on side-effectful re-renders. Today this invariant is implicit and the implementation violates it.

## Impact

- Code: `src/modules/postgres/data/useTableData.ts` (~10-line patch).
- New dev-deps: `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom` (and a `vitest.config.ts` + `src/test/setup.ts`).
- New scripts: `package.json` gains a `test` script.
- New test file: `src/modules/postgres/data/useTableData.test.tsx`.
- Spec delta: one modified requirement in `postgres-data-grid`.
- Risk: very low. Single-hook patch, no contract changes, behavior under StrictMode and single-mount both improve. Affected blast radius: the table data viewer on first open. No migrations, no new infra beyond test tooling.
