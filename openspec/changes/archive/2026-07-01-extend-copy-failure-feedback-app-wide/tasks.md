## 1. Shared helper

- [x] 1.1 Confirm the #213 `writeClipboardText(text): Promise<boolean>` and `COPY_FAILED_MESSAGE = "Copy failed"` are present in `packages/app/src/platform/grid/gridCopy.ts`
- [x] 1.2 Promote `writeClipboardText` and `COPY_FAILED_MESSAGE` to a neutral shared module (e.g. `platform/clipboard/index.ts`) and re-export from `gridCopy.ts` so grid call sites stay unchanged (fallback: keep in `gridCopy.ts` and import from there if promotion adds churn)

## 2. Structure / DDL viewers

- [x] 2.1 `modules/postgres/structure/RawSubtab.tsx` — route `onCopy` through the shared helper; on failure `useToast().show("Copy failed", "error")`; set "Copied" only on success; keep the empty-DDL early return
- [x] 2.2 `modules/mysql/structure/RawSubtab.tsx` — same wiring as 2.1
- [x] 2.3 `modules/mssql/structure/RawSubtab.tsx` — same wiring as 2.1; keep the `isEncrypted` early return

## 3. Dynamo copy sites

- [x] 3.1 `modules/dynamo/tables/DynamoConnectionSubtree.tsx` — add a `const onCopyError = (m) => toast.show(m, "error")`; route all three write sites (`handleContextCopyName`, cached-ARN, reconstructed-ARN) through the shared helper with `onCopyError`
- [x] 3.2 `modules/dynamo/ConnectionForm.tsx` — route the copy-SSO-command click through the shared helper; toast on failure
- [x] 3.3 `modules/dynamo/data-view/MetadataView.tsx` — in `CopyButton`, call `useToast()`, route through the shared helper, set `copied` only on success, toast on failure

## 4. Query history, AI, shell, CloudWatch

- [x] 4.1 `modules/query-history/HistoryTab.tsx` — move/adapt `handleCopySql` to use the shared helper and the component's toast; toast on failure
- [x] 4.2 `modules/ai/components/ChatPanel.tsx` — route the code-block `handleCopy` through the shared helper; toast on failure (replace empty catch)
- [x] 4.3 `platform/shell/UpdaterLogsDialog.tsx` — route `handleCopy` through the shared helper; set "Copied" only on success; toast on failure (replace empty catch)
- [x] 4.4 `modules/cloudwatch/insights/ResultPanel.tsx` — route the copy through the shared helper; toast on failure

## 5. Verification

- [x] 5.1 Grep `packages/app/src` for remaining direct `navigator.clipboard.writeText` outside the grid/clipboard helper module to confirm all non-grid sites were migrated
- [x] 5.2 Confirm no site shows its success affordance on a failed write, and no toast fires on a no-op / successful copy
- [x] 5.3 Run the app's typecheck/lint (and any existing tests) to confirm the new `useToast`/async handlers compile cleanly
