## 1. Fix tab-routing connection resolution

- [x] 1.1 In `packages/app/src/platform/shell/tabs/TabsContext.tsx`, update `extractConnectionId` to also read `payload.initialConnectionId` (string) when `payload.connectionId` is absent, keeping the `connectionId` path first so MySQL/MSSQL are unaffected.
- [x] 1.2 Verify the type guard still narrows both fields to `string` and returns `null` for absent/non-string values; leave the `?? focusedConnectionId` fallback in `open()` intact.

## 2. Tests

- [x] 2.1 Add/extend a unit test for `extractConnectionId` (or `TabsProvider.open` routing) asserting a `postgres-query` payload with `initialConnectionId` resolves to that connection set even when no connection is focused.
- [x] 2.2 Add a test asserting a `postgres-query` tab whose `initialConnectionId` differs from the focused connection lands in the `initialConnectionId` set, not the focused one.
- [x] 2.3 Add a regression test asserting MySQL/MSSQL payloads (`connectionId`) still route correctly (the `connectionId` branch takes precedence).

## 3. Verify end-to-end

- [x] 3.1 With a Postgres connection that has at least one saved query, confirm double-click, `Open`, and `Open in new tab` each open (or focus, per the dedup rules) a `postgres-query` tab loaded with the query SQL — including when no connection is focused. _(manual desktop QA — passed)_
- [x] 3.2 Confirm `Open in new tab` always creates a second tab and `Open` on an already-open saved query focuses the existing tab. _(manual desktop QA — passed)_
- [x] 3.3 Run the app's frontend test/lint suite and ensure it passes.
