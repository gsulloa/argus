## Context

PR #213 consolidated the three grid copy paths and introduced a boolean-returning write helper, `writeClipboardText(text): Promise<boolean>` in `platform/grid/gridCopy.ts`, plus the grid pattern:

```ts
const toast = useToast();
const onCopyError = (msg: string) => toast.show(msg, "error");
```

The failure message is the constant `COPY_FAILED_MESSAGE = "Copy failed"` in `gridCopy.ts`. `useToast()` (from `platform/toast`) exposes `show(message: string, kind?: "info" | "success" | "error")` and is already available app-wide (it degrades to a console log when no provider is mounted).

The non-grid copy sites today each hand-roll `navigator.clipboard.writeText(...)` with inconsistent (or absent) error handling — empty `catch`, `console.error`/`console.warn`, or a bare `void ...` fire-and-forget. None import `useToast`. This change makes them consistent with the grid.

Inventory (from code search), all under `packages/app/src`:

| Site | Value | Current handling |
|---|---|---|
| `platform/shell/UpdaterLogsDialog.tsx` | updater logs | empty catch |
| `modules/dynamo/ConnectionForm.tsx` | SSO CLI command | none (fire-and-forget) |
| `modules/dynamo/tables/DynamoConnectionSubtree.tsx` | table name / ARN (3 sites) | none |
| `modules/dynamo/data-view/MetadataView.tsx` (`CopyButton`) | metadata value | `.then()` only |
| `modules/postgres/structure/RawSubtab.tsx` | DDL | `console.error` |
| `modules/mysql/structure/RawSubtab.tsx` | DDL | `console.error` |
| `modules/mssql/structure/RawSubtab.tsx` | DDL | `console.error` |
| `modules/query-history/HistoryTab.tsx` | SQL | `.catch()` + `console.error` |
| `modules/ai/components/ChatPanel.tsx` | code block | empty catch |
| `modules/cloudwatch/insights/ResultPanel.tsx` | result copy | none |

## Goals / Non-Goals

**Goals:**
- Every non-grid copy site surfaces write failures via a `"Copy failed"` error toast, matching the grid.
- Reuse the #213 write-helper contract; do not re-implement per-site try/catch around `navigator.clipboard.writeText`.
- Keep each site's existing success affordance ("Copied" label/checkmark) unchanged; stay silent on success and on no-op.
- One consistent failure message string across grid and non-grid.

**Non-Goals:**
- No change to grid copy paths (already covered by #213 / `grid-row-copy` spec).
- No new success toasts, no changes to what content each site copies, no changes to the low-level formatting helpers.
- No new clipboard fallback strategy (e.g. `execCommand`) — out of scope; only reporting changes.

## Decisions

### Decision 1: Reuse `writeClipboardText`, promoted to a neutral location

The grid's `writeClipboardText` already returns `Promise<boolean>` and is exactly the contract non-grid sites need. Importing a function named after "grid" into Dynamo/AI/updater code reads oddly, so promote it (and the `COPY_FAILED_MESSAGE` constant) to a small shared module — e.g. `platform/clipboard/index.ts` — and re-export from `gridCopy.ts` so the grid keeps working unchanged.

- **Why:** single source of truth for the write + failure semantics and the message string; avoids a "grid" import in non-grid modules.
- **Alternative considered:** import directly from `platform/grid/gridCopy.ts`. Rejected only on naming/coupling grounds; functionally fine and is an acceptable fallback if promotion proves noisy. The apply step MAY keep it in `gridCopy` if promotion adds churn — the spec only requires reuse of the helper, not its location.

### Decision 2: Per-site error callback, `useToast` in each component

Each affected component calls `const toast = useToast();` and, on `writeClipboardText(...) === false`, calls `toast.show("Copy failed", "error")`. This mirrors the grid's `onCopyError` pattern exactly.

- **Handlers become async** where they aren't already: `await writeClipboardText(text)` then branch. Fire-and-forget sites (`void navigator.clipboard.writeText(x)`) become `void writeClipboardText(x).then(ok => { if (!ok) toast.show("Copy failed", "error"); })` or an async handler.
- **Success affordance ordering:** only set the "Copied" state when `ok === true`. Sites that currently set it unconditionally inside `.then()` (MetadataView) or after a bare `await` (RawSubtab) move it into the success branch so a failure does not falsely flash "Copied".

### Decision 3: `MetadataView.CopyButton` and `HistoryTab` get toast from the nearest component

`CopyButton` is a small local component; it can call `useToast()` itself (hooks are fine in any component). `HistoryTab`'s `handleCopySql` is a module-scope function — convert to a closure inside the component or thread the toast in, consistent with how the component is structured.

### Decision 4: `DynamoConnectionSubtree` has three write sites

All three (`handleContextCopyName`, cached-ARN branch, reconstructed-ARN branch of `handleContextCopyArn`) route through the shared helper with the same `onError`. A single `const onCopyError = (m: string) => toast.show(m, "error")` in the component keeps it DRY.

## Risks / Trade-offs

- **[Toast provider absent in some surface]** → `useToast()` already degrades to a console log when no provider is mounted, so calling it is always safe; no crash risk.
- **[Over-triggering toast on no-op]** → Guard: only call the helper when there is something to copy (sites already early-return on empty DDL / missing value), and only toast when the helper returns `false`. No toast on the early-return path.
- **[Success label flashing on failure]** → Mitigated by moving the "Copied" state set into the success branch (Decision 2).
- **[Promotion churn]** (Decision 1) → Kept minimal by re-exporting from `gridCopy.ts`; grid call sites unchanged. If churn is undesirable, importing from `gridCopy.ts` directly is an accepted fallback.

## Migration Plan

Pure additive UI-feedback change; no data or API migration. Ships behind no flag. Rollback is a straight revert of the touched call sites. Depends on the #213 helper already being present on `dev`.

## Open Questions

- None blocking. Location of the shared helper (Decision 1) is the only soft choice and does not affect the spec contract.
