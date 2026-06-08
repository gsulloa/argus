## 1. Types

- [x] 1.1 Extend `BuilderState.modelSelection` in `src/modules/dynamo/data-view/types.ts` with optional `skOp?: "=" | "<" | "<=" | ">" | ">=" | "between" | "begins_with"` and `skMaxParams?: Record<string, string>` (both optional; absence = "auto"/fill-rule). Document that `skMaxParams` is the upper bound used only for `between`.

## 2. Compiler

- [x] 2.1 Extend `compileModel` in `modelCompiler.ts` to accept an optional 4th argument `{ skOp?, skMaxParams? }`. When `skOp` is absent or `"auto"`, keep the current fill-rule behaviour exactly (no regression).
- [x] 2.2 When `skOp` is a single-value operator (`=`, `<`, `<=`, `>`, `>=`, `begins_with`) and the access pattern has an `sk` template on an index with a sort key: substitute the `sk` template fully with `params`, emit `sortKey = { name, op: skOp, value: typed(value) }` typed from the SK attribute. Error on an empty required SK param (naming it); `begins_with` valid only on an `S`-typed key (else error). Partition-key handling unchanged.
- [x] 2.3 When `skOp === "between"`: substitute the `sk` template with `params` (min) and with `skMaxParams` (max); emit `sortKey = { name, op: "between", value: { min, max } }` with SK-typed values. Error on empty bound params (naming them).
- [x] 2.4 Unit tests (`modelCompiler.test.ts`): explicit `>=`/`<=` build a range sort key equal to the raw equivalent; `between` builds `{ min, max }`; `begins_with` on an `N` key errors; empty SK param under an explicit op errors naming it; `auto`/absent reproduces existing equality + begins_with + partition-only results unchanged.

## 3. QueryBuilder UI

- [x] 3.1 In `QueryBuilder.tsx` model mode, compute `pkParams` and `skParams` (idents per template) and render a `*` required marker on each param input label when the param is in `pkParams`, or in `skParams` when the access pattern has an `sk`. Visual only — no change to `params`, validity, or the compiled query. Add `aria-required` and a `data-testid` hook for the marker.
- [x] 3.2 Render a sort-key operator selector in model mode only when the selected access pattern has an `sk` template and the selected index has a sort key. Value is `modelSelection.skOp ?? "auto"`; options `auto, =, <, <=, >, >=, between, begins_with`. On change, set `modelSelection.skOp` (clearing it on `auto`) and recompile/revalidate via the existing model-mode flow.
- [x] 3.3 When `skOp === "between"`, render an additional input per SK param (the upper bound) bound to `modelSelection.skMaxParams`, labeled as the upper bound ("to"/"upper bound" per `DESIGN.md`). Primary inputs remain the lower bound and continue feeding the PK. Pass `skOp`/`skMaxParams` into `compileModel` everywhere model mode compiles (`revalidate`, `modelCompileResult`, `setBuilderMode`, `setModelEntity`, `setModelAccessPattern`, `setModelParam`, and the new handlers).
- [x] 3.4 Component tests (`QueryBuilder.test.tsx`): required `*` markers appear on PK and (when `sk` present) SK params and not on SK-only params when there is no `sk`; picking `>=` issues a range sort-key Query matching raw; picking `between` reveals the upper-bound inputs and compiles a `{ min, max }` sort key; `auto` reproduces today's behaviour.

## 4. Verification

- [x] 4.1 `npx vitest run src/modules/dynamo/data-view` and `npx tsc --noEmit` are clean for the touched files.
- [ ] 4.2 Manual check against a real STD table: pick an entity + access pattern, confirm PK/SK `*` markers, run an equality query (`auto`), then a `>=`/`between` sort-key query, and confirm results match the equivalent raw-mode query.
