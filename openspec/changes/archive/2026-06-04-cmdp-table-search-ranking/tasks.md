## 1. Scorer helper

- [x] 1.1 Create `src/platform/command-palette/scoreTableEntry.ts` exporting a pure function `scoreTableEntry(query, parts, fallbackScore)` where `parts = { schema, name, connectionName }`. Implement the tier ladder from `design.md` (exact-name > prefix-name > schema-qualified combined > substring-name > exact-schema > prefix-schema > substring-schema > connection tiers > fuzzy fallback).
- [x] 1.2 Handle empty query (return `1` — keep all rows, matches existing `shouldFilter=false` path) and trim/lowercase the query once at entry.
- [x] 1.3 For two-segment `qSchema.qName` queries, compute schema-side tier and name-side tier independently; combine so any `auth.*` match outranks any non-`auth` match for query `auth.us`.
- [x] 1.4 Make the fallback tier additive: a small fraction (e.g. `fallbackScore * 0.001`) added on top of the tier base so structured tiers never get overtaken by fuzzy noise.
- [x] 1.5 Return `0` only when neither any structured tier nor cmdk's fuzzy fallback matched (so cmdk hides the row).

## 2. Scorer unit tests

- [x] 2.1 Add `src/platform/command-palette/scoreTableEntry.test.ts` (or co-located test file matching project convention).
- [x] 2.2 Cover each scenario in `specs/table-quick-switcher/spec.md`:
  - exact name beats longer substring (`order` → `client.order` > `client.assistant_manual_pending_orders`)
  - prefix on name beats substring elsewhere (`ord` → `public.orders` > `client.assistant_manual_pending_orders`)
  - two-segment `auth.us` ranks `auth.users` > `auth.user_sessions` > `public.users`
  - mid-word fuzzy fallback (`scrip` matches `public.subscriptions`)
  - connection-name match still works (`staging` filters to `supabase-staging` entries)
  - `usr` → `public.users` ranks at top (existing behaviour preserved)
- [x] 2.3 Assert `scoreTableEntry("", …)` returns a non-zero score (so empty query keeps everything visible when filter runs).

## 3. PaletteShell filter plumbing

- [x] 3.1 In `src/platform/command-palette/PaletteShell.tsx`, add an optional prop `filter?: (value: string, search: string, keywords?: string[]) => number`.
- [x] 3.2 Forward `filter` to the underlying `<Cmdk …>` root only when provided; default (omitted) MUST preserve current behaviour for ⌘K command palette consumers.

## 4. TablePalette wiring

- [x] 4.1 In `src/platform/command-palette/TablePalette.tsx`, on each `<Cmdk.Item>` for a table row, attach `keywords={[entry.schema, entry.name, entry.connectionName, entry.kind]}` so the custom filter can recover the parts without parsing `value`.
- [x] 4.2 Build a memoised `filter` callback that:
  - strips any leading `__recent ` sentinel from the `value` before scoring (purely defensive — scoring uses `keywords` directly)
  - reads `[schema, name, connectionName] = keywords` and delegates to `scoreTableEntry`
  - passes the cmdk default score (computed via `command-score` import) as the `fallbackScore` argument, OR — if importing `command-score` adds friction — uses a tiny inline implementation: a substring check across the joined value returning a small positive number when matched, `0` otherwise
- [x] 4.3 Pass the memoised `filter` into `PaletteShell` via the new prop.
- [x] 4.4 Verify `shouldFilter` remains gated on `search.length > 0` — the custom filter should NOT run on empty queries (which would also break the Recent group rendering).

## 5. Manual + integration verification

- [x] 5.1 Run `pnpm tsc --noEmit` (or repo-equivalent type check) — no new type errors.
- [x] 5.2 Run the project's lint + test commands; ensure new unit tests pass. (11 new tests pass; full suite 1130/1131 — single pre-existing flake in `dynamo/tables/CacheProvider.test.tsx`, unrelated to this change.)
- [ ] 5.3 Launch the app, connect to a database with both `client.order` and `client.assistant_manual_pending_orders` (or any analogous pair — the README's docs sample DB works), press ⌘P, type `order`, confirm `client.order` is the first result. _Requires running Tauri dev build — defer to PR reviewer / manual smoke._
- [ ] 5.4 Repeat with `ord`, `auth.us`, `staging`, `scrip` — verify the ordering matches the spec scenarios. _Same as 5.3._
- [ ] 5.5 Press ⌘K (command palette) and confirm command ordering is unchanged from before this PR (regression check on the shared `PaletteShell`). _Same as 5.3._
- [ ] 5.6 Open the switcher with an empty query — Recent group still renders at the top, no regression in eager-loading or empty states. _Same as 5.3._

## 6. Wrap-up

- [x] 6.1 Update `src/platform/command-palette/TablePalette.tsx` to reference the new helper module via the project's normal import path conventions.
- [x] 6.2 Self-review the diff against `proposal.md`, `design.md`, and `specs/table-quick-switcher/spec.md`; ensure no requirement is uncovered and no out-of-scope change crept in.
- [ ] 6.3 Reference issue #55 in the PR description and link to the change folder `openspec/changes/cmdp-table-search-ranking/`. _Pending PR creation._
