## Why

PR #213 made **grid** clipboard copy failures visible via a non-blocking error toast, but that fix was intentionally scoped to the three grid copy paths. The remaining ~10 non-grid "copy" affordances across the app (DDL, SQL, ARNs, table names, CLI commands, updater logs, AI code blocks, log results) still swallow clipboard errors silently — either an empty `catch`, a `console.error/warn`, or a fire-and-forget promise with no `.catch()`. A copy that silently does nothing is a confusing dead end for the user. This follow-up brings those sites up to the same app-wide contract established for the grid.

## What Changes

- Add a small shared clipboard helper used by all non-grid copy sites that writes text and reports success/failure, reusing the boolean-returning contract introduced in #213 (`writeClipboardText` in `platform/grid/gridCopy.ts`, or a promoted shared equivalent).
- Wire each non-grid copy call site to show a non-blocking error toast (`useToast().show("Copy failed", "error")`) on write failure only — never on success, never on a no-op (e.g. nothing to copy).
- Preserve each site's existing success affordance (the transient "Copied" label / checkmark) unchanged.
- Sites covered:
  - `platform/shell/UpdaterLogsDialog.tsx` — copy updater logs (empty catch today)
  - `modules/dynamo/ConnectionForm.tsx` — copy SSO CLI command (no handling today)
  - `modules/dynamo/tables/DynamoConnectionSubtree.tsx` — copy table name / ARN (3 call sites, no handling)
  - `modules/dynamo/data-view/MetadataView.tsx` — `CopyButton` (`.then()` only, no catch)
  - `modules/postgres/structure/RawSubtab.tsx`, `modules/mysql/structure/RawSubtab.tsx`, `modules/mssql/structure/RawSubtab.tsx` — copy DDL (`console.error` today)
  - `modules/query-history/HistoryTab.tsx` — copy SQL (`console.error` today)
  - `modules/ai/components/ChatPanel.tsx` — copy code block (empty catch today)
  - `modules/cloudwatch/insights/ResultPanel.tsx` — copy (no handling today; discovered during inventory, included for completeness)
- No behavioral change to the grid copy paths (already covered by #213 / `grid-row-copy` spec) and no change to the low-level formatting helpers.

## Capabilities

### New Capabilities
- `clipboard-copy-feedback`: App-wide contract that any non-grid copy-to-clipboard action surfaces write failures to the user via a non-blocking error toast and stays silent on success, mirroring the grid copy-feedback behavior.

### Modified Capabilities
<!-- None. Grid copy failure feedback is already specified in grid-row-copy (added by #213); this change only covers the non-grid sites, which have no prior copy-feedback requirement to modify. -->

## Impact

- **UI/UX**: Failed copies across Dynamo, structure/DDL viewers, query history, AI chat, updater logs, and CloudWatch insights now show a "Copy failed" error toast instead of failing silently. Successful copies are unchanged.
- **Code**: ~10 call sites across `platform/shell`, `modules/dynamo`, `modules/postgres|mysql|mssql/structure`, `modules/query-history`, `modules/ai`, and `modules/cloudwatch`; each gains a `useToast` usage and routes its write through the shared helper. Depends on the #213 write-helper contract already present on `dev`.
- **No** new dependencies, backend, or persistence changes; toast primitive (`platform/toast`) already exists app-wide.
