## Context

"By model" mode in `QueryBuilder.tsx` lets the user pick an entity + access pattern and fill one input per distinct `${param}` found across the pattern's `pk`/`sk` templates. `modelCompiler.compileModel(ap, params, describe)` turns that into a `BuilderState.query` (partition key + optional sort key) consumed unchanged by `builderCompiler`. Today the sort key is implicit: the fill rule emits `=` when all params are filled, `begins_with` on a trailing-empty string prefix, or drops the sort key (partition-only) for a bare/empty trailing param. The raw builder, by contrast, already exposes a sort-key operator selector (`=`, `<`, `<=`, `>`, `>=`, `between`, `begins_with`) and `BuilderState.query.sortKey` already models all of those (including `between` with `{ min, max }`).

Two gaps: (1) the param inputs don't signal which are mandatory, and (2) "By model" can't express sort-key range conditions that raw already can.

## Goals / Non-Goals

**Goals:**
- Show a `*` required marker on each PK parameter input, and on each SK parameter input when the access pattern has an `sk` template — visual only.
- Let the user choose a sort-key operator in "By model" mode from the same set the raw builder offers, while keeping today's implicit behaviour as the default.
- Keep "By model" and "Raw (PK/SK)" producing equivalent requests for equivalent key values; leave the downstream Scan/Query compiler untouched.

**Non-Goals:**
- No backend / `dynamo_model` format / parser / command changes.
- No changes to filter rows, raw mode, or the model editor.
- No new sort-key semantics beyond what raw mode already expresses.

## Decisions

### D1. Required marker is derived from template params, visual only

Compute two sets per selected access pattern: `pkParams` (idents in the `pk` template) and `skParams` (idents in the `sk` template, empty when there is no `sk`). A param input is marked required (`*` appended to its label, e.g. `userId *`) when it is in `pkParams`, or in `skParams` when the access pattern has an `sk` template. The marker is presentation only — it does not alter the params object, `compileModel`, validity, or the compiled query. Implemented by extending the existing per-param render loop (`apParams.map(...)`) with a `required` boolean and an `aria-required`/visible `*`.

- **Why:** PK must always fully resolve (the compiler already errors on an unresolved PK), and when an `sk` template exists its params are what produce a precise sort-key match — exactly the fields the user asked to flag. Keeping it visual avoids changing the well-tested compile/validity path.
- **Alternative considered:** marking only the params strictly required by the *current* sort-key operator (e.g. none for a dropped SK). Rejected — more code, and the user asked for "PK, and SK when there is an SK", which is the template-membership rule above.

### D2. Explicit sort-key operator via `modelSelection.skOp`, with `"auto"` preserving today's behaviour

Add to `BuilderState.modelSelection`:
```
skOp?: "=" | "<" | "<=" | ">" | ">=" | "between" | "begins_with"   // undefined → auto (fill-rule)
skMaxParams?: Record<string, string>                                // upper-bound params, used only for "between"
```
The sort-key operator selector renders in "By model" mode only when the chosen access pattern has an `sk` template **and** the selected index has a sort key. Its value is `skOp ?? "auto"`; options are `auto`, `=`, `<`, `<=`, `>`, `>=`, `between`, `begins_with`.

`compileModel` gains an optional argument carrying `skOp` (and `skMaxParams`):
- `skOp` absent / `"auto"` → today's fill-rule inference, unchanged.
- `skOp` is a single-value op (`=`, `<`, `<=`, `>`, `>=`, `begins_with`) → substitute the `sk` template with `params` (full substitution) to a value `V`; emit `sortKey = { name, op: skOp, value: typed(V) }`, where the type comes from the SK attribute. `begins_with` is valid only on an `S`-typed sort key (same rule as the fill-rule degrade); on a non-`S` key it is an error. An empty required SK param under an explicit op is an error naming that param.
- `skOp` is `"between"` → substitute the `sk` template once with `params` (min) and once with `skMaxParams` (max); emit `sortKey = { name, op: "between", value: { min: typed(Vmin), max: typed(Vmax) } }`.

The emitted `sortKey` is exactly the shape the raw builder produces, so `builderCompiler` and the IPC request are identical to the equivalent raw query — preserving the spec's "By model and Raw produce equivalent requests" guarantee.

- **Why `"auto"` default:** existing persisted `modelSelection` values have no `skOp`; defaulting to the fill-rule keeps every current behaviour and existing test green, while the explicit operators are purely additive. Partition-only queries remain reachable through `auto` (empty/bare trailing param), so no separate "remove sort key" affordance is needed.
- **Alternative considered:** defaulting the selector to `=`. Rejected — it would turn today's "leave the trailing param empty → `begins_with`" convenience into an error and change archived behaviour.

### D3. `between` upper bound via a parallel SK-param input group

Because params are shared across PK and SK and rendered once, `between` needs a second value for the SK-only bound. When `skOp === "between"`, render an additional input per **SK** param (the upper bound), bound to `modelSelection.skMaxParams`. The primary param inputs are the lower bound (and continue to feed the PK); the upper-bound inputs affect only the SK `max`. For a param shared by PK and SK, the PK uses the lower-bound value.

- **Why:** keeps the templated UX (the user fills the same `${param}` slots) rather than asking for a raw literal SK value, and reuses the existing per-param rendering.
- **Alternative considered:** a single raw "max" text field bypassing the template. Rejected — inconsistent with the templated model paradigm and harder to validate against the key type.

## Risks / Trade-offs

- **A param shared between PK and SK under `between`** could surprise users (the upper-bound input only moves the SK max). → Mitigation: label the upper-bound group clearly ("to" / "upper bound") and scope it to SK params only; document in the param hint.
- **`begins_with` / range op selected on a non-`S` sort key** → the compiler returns an error and Save/Run is blocked with an inline message, identical to raw-mode behaviour. No silent wrong query.
- **Persisted `modelSelection` without `skOp`** → resolves to `"auto"`; zero behaviour change, no migration needed.
- **Scope creep into raw mode** → the operator vocabulary is reused but the raw builder code path is untouched; the change is confined to model-mode rendering + `compileModel`.

## Migration Plan

Additive and frontend-only. New optional fields on `BuilderState.modelSelection` (`skOp`, `skMaxParams`); absence means today's behaviour. No persisted-state migration, no backend or doc-format change. Rollback = revert the frontend commit.

## Open Questions

- None blocking. Label wording for the `between` upper-bound group ("to" vs "upper bound") is a copy decision to settle during implementation against `DESIGN.md`.
