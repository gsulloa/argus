## 1. Rust: activity-log module

- [x] 1.1 Create `src-tauri/src/modules/activity_log/mod.rs` exposing `ActivityLogEntry`, `ActivityKind`, `Origin`, `Status`, `Metric`, `ActivityError` types with `serde::Serialize` and snake_case rename rules.
- [x] 1.2 In the same module, add a `v: u8 = 1` const and embed it in every emitted entry.
- [x] 1.3 Add `emit_activity(app: &AppHandle, entry: ActivityLogEntry)` helper that emits the Tauri event `argus:activity-log`. Log via `tracing::debug!` when emission fails (do not propagate; the command's primary work must not fail because of the log).
- [x] 1.4 Add a `ParamsFormatter` helper that takes `&[Box<dyn ToSql + Sync>]` and produces `Vec<String>` of `Debug`-formatted values, each truncated to 200 chars with a `…` marker on truncation.
- [x] 1.5 Wire the new module into `src-tauri/src/modules/mod.rs` so it is reachable from sibling modules.

## 2. Rust: emit from Postgres connection lifecycle commands

- [x] 2.1 In `postgres_test_connection`: capture `started = Instant::now()` at entry; emit on both success and error paths with `kind: TestConnection`, `connection_id: None`, `origin: User`, `metric: ServerVersion(...)` on ok / `None` on err.
- [x] 2.2 In `postgres_connect`: emit on both success and error with `kind: Connect`, `connection_id: Some(id)`, `origin: User`, `metric: ServerVersion(...)` on ok.
- [x] 2.3 In `postgres_disconnect`: emit `kind: Disconnect`, `connection_id: Some(id)`, `origin: User`, `metric: None`, `status: Ok`.
- [x] 2.4 Verify the existing `postgres:active-changed` event still fires unchanged for connect/disconnect.

## 3. Rust: emit from schema-browser commands

- [x] 3.1 In `postgres_list_schemas`: emit on both paths with `kind: ListSchemas`, `origin: Auto`, `metric: Items(schemas.len())` on ok.
- [x] 3.2 In `postgres_list_relations`: emit with `kind: ListRelations`, `origin: Auto`, `metric: Items(tables + views + matviews)` on ok.
- [x] 3.3 In `postgres_list_structure`: emit with `kind: ListStructure`, `origin: Auto`, `metric: Items(sum of Some(...).len(), None → 0)` on ok. The presence of entries in `failures` must NOT flip the entry to `status: Err`.
- [x] 3.4 In `postgres_list_table_extras`: emit with `kind: ListTableExtras`, `origin: Auto`, `metric: Items(indexes_len + triggers_len, None → 0)` on ok.

## 4. Rust: emit from data-grid commands

- [x] 4.1 Add an optional `origin: Option<Origin>` argument to `postgres_query_table` (defaulting to `Origin::Auto` when `None`).
- [x] 4.2 In `postgres_query_table`, after building the SELECT and before returning, emit with `kind: QueryTable`, `sql: Some(sql.clone())`, `params: Some(ParamsFormatter::format(&params))`, `metric: Rows(rows.len() as u64)` on ok / `None` on err. Capture timing at command entry.
- [x] 4.3 Add an optional `origin: Option<Origin>` argument to `postgres_count_table` (defaulting to `Origin::Auto`).
- [x] 4.4 In `postgres_count_table`, emit with `kind: CountTable`, `sql: Some(sql.clone())`, `params: Some(...)`, `metric: Count(count)` on ok.
- [x] 4.5 Confirm the existing `query_ms` field on the response is unchanged (the activity log is additive).

## 5. Rust: tests

- [x] 5.1 Add a unit test in `activity_log` covering `ParamsFormatter` truncation at 200 chars with the `…` marker.
- [x] 5.2 Add a serialization test asserting `ActivityLogEntry` round-trips with snake_case keys and that `kind` discriminant matches the values in the spec (`"query_table"`, `"count_table"`, etc.).
- [x] 5.3 Add a smoke test (gated on a docker/test fixture) verifying that `postgres_query_table` emits exactly one event per call (using a captured `MockApp` or similar test harness if one exists; otherwise document a manual test in the change folder's `.notes` file).

## 6. Frontend: activity-log module scaffold

- [x] 6.1 Create `src/platform/activity-log/types.ts` mirroring the Rust payload (TypeScript types: `ActivityLogEntry`, `ActivityKind`, `Origin`, `Status`, `Metric`, `ActivityError`).
- [x] 6.2 Create `src/platform/activity-log/store.ts` exporting `ActivityLogProvider` (Context + `useReducer` ring buffer of capacity 1000), `useActivityLog()` (returns `entries`, `counts`, `clear()`), and a derived `useFilteredActivityLog(showAuto: boolean)` hook.
- [x] 6.3 In `store.ts`, mount the Tauri event listener (`listen<ActivityLogEntry>("argus:activity-log", ...)`) once on provider mount; tear it down on unmount.
- [x] 6.4 Wrap the app root with `<ActivityLogProvider>` (in `src/main.tsx` or equivalent root, alongside other Context providers).

## 7. Frontend: bottom panel slot in the shell

- [x] 7.1 Update `src/platform/shell/Layout.module.css`: change `grid-template-rows` to support an optional logs row (`1fr var(--logs-handle, 0px) var(--logs-height, 0px) 28px`); add styles for `.logsHandle` and `.logsPanel` matching the existing handle pattern.
- [x] 7.2 Update `src/platform/shell/Layout.tsx`: add an optional `bottomPanel` prop; when present, render a drag handle + `<section className={styles.logsPanel}>{bottomPanel}</section>` with `grid-column: 1 / -1`. Wire `--logs-height` and `--logs-handle` CSS vars from settings.
- [x] 7.3 Extend `LayoutCtx` with `logsOpen`, `setLogsOpen`, `toggleLogs`, `logsHeight`, `setLogsHeight` and persist `logsOpen` (default `false`) and `logsHeight` (default `220`, clamp 120–480) via `useSetting("activityLog.open", false)` and `useSetting("activityLog.height", 220)`.
- [x] 7.4 Reuse `useDragHandle` for the new logs handle, mirroring how `inspectorHandle` works (drag up grows the panel).

## 8. Frontend: activity-log panel UI

- [x] 8.1 Create `src/platform/activity-log/ActivityLogPanel.tsx`: header (title `Activity`, "Show internal" toggle bound to `useSetting("activityLog.showAuto", false)`, clear button calling `useActivityLog().clear()`), and a virtualized list using the same primitives as the data grid where reasonable (or a plain scrollable list if rows ≤ buffer cap and performance is fine — 1000 rows of single-line content should not need virtualization).
- [x] 8.2 Create `src/platform/activity-log/ActivityLogRow.tsx` rendering one collapsed row: timestamp (`HH:mm:ss.SSS`, mono), connection label (resolved via `useConnections()` from `connection_id`, or `—`), kind, summary (truncated SQL @ 120 chars when present, else kind label), `duration_ms` right-aligned with `ms` suffix, and a status/metric column (success → metric formatted; error → `error.message` colored `var(--danger)`).
- [x] 8.3 In `ActivityLogRow`, on click, expand inline to show full SQL (preformatted), numbered bind params list, full-form metric, and full error text + SQLSTATE if any. Esc collapses.
- [x] 8.4 Implement auto-stick-to-bottom: track scroll position; when within 32px of the tail, programmatically scroll on each new entry. When scrolled away, render an absolutely-positioned `N new` indicator that resumes auto-stick on click.
- [x] 8.5 Apply DESIGN.md tokens: panel background `var(--surface)`, top divider `1px solid var(--border)`, row hairlines `1px solid var(--hairline)`, `Geist Mono` for SQL/timestamp/duration columns with `feature-settings: "zero" on`, body in `Geist`, status font sizes `--text-xs` (timestamp) and `--text-sm` (rest).

## 9. Frontend: status-bar entry point

- [x] 9.1 Update `src/platform/shell/StatusBar.tsx`: add an `Activity Log` button on the right side rendering `Logs (N) ⌃` (closed) / `Logs (N) ⌄` (open), where N is the count of entries that pass the active origin filter (read from `useFilteredActivityLog(showAuto).length`).
- [x] 9.2 Wire the button's onClick to `toggleLogs` from `useLayout()`.
- [x] 9.3 Ensure the button is keyboard accessible (focusable, Enter/Space activates).
- [x] 9.4 Verify the existing inspector toggle in the status bar still functions and is not visually crowded by the new control.

## 10. Frontend: wire `origin` through data-grid call sites

- [x] 10.1 Update `src/modules/postgres/data/api.ts`: `queryTable` and `countTable` accept an optional `origin: "user" | "auto"` argument (default `"auto"`) and forward it to `invoke()`.
- [x] 10.2 Update every data-grid call site (`useTableData`, count button handler, paging handler, sort/filter change handlers) to pass `origin: "user"` for user-initiated calls.
- [x] 10.3 Audit any other call sites in `src/modules/postgres/` that currently invoke `postgres_query_table` or `postgres_count_table`; tag them as `auto` explicitly if they are not user-initiated.

## 11. Settings keys

- [x] 11.1 Confirm `activityLog.open` (boolean), `activityLog.height` (number), and `activityLog.showAuto` (boolean) are persisted via `useSetting` with the documented defaults.
- [x] 11.2 Verify the keys round-trip across an app restart (manual smoke test).

## 12. Verification

- [x] 12.1 Manual test: connect to a Postgres instance, browse a schema, open a table, click "Count rows", trigger an error (open a non-existent table). Confirm every action shows up as a single row in the panel with the correct origin tag, sql, params, duration, and metric.
- [x] 12.2 Manual test: toggle "Show internal activity" off and on; confirm auto entries hide/show without losing user entries.
- [x] 12.3 Manual test: drag the panel handle to its min and max bounds; confirm clamps at 120 and 480.
- [x] 12.4 Manual test: quit and relaunch with the panel open at 300px and `showAuto` enabled; confirm both persist.
- [x] 12.5 Confirm `tracing` log file (`argus.log` in release build) still receives the same lines it always did — the activity log is additive, not a replacement.
- [x] 12.6 Confirm `pnpm tsc --noEmit`, `pnpm lint`, and `cargo test --manifest-path src-tauri/Cargo.toml` all pass.
