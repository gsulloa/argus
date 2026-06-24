## Context

The Workspace sidebar identity header is rendered by `ConnectionIdentityHeader` in `packages/app/src/platform/shell/WorkspaceShell.tsx` (~line 305). It currently shows: an engine icon, the connection display name, and an `identityMeta` row containing the engine label (`identityEngine`) plus a prod/non-prod dot (`identityEnvDot`). No engine surfaces its AWS region here.

All three AWS engines (DynamoDB, CloudWatch, Athena) expose region the same way: the connection params carry `region: string`, and the runtime "active connection" object also carries `region: string`. For DynamoDB:
- `DynamoParams.region` (`modules/dynamo/types.ts`)
- `ActiveDynamoConnection.region`, read via the `useActiveDynamoConnections()` hook (`modules/dynamo/useActiveConnections.ts`), which already exposes a `getActive(connectionId)` lookup used elsewhere (e.g. `DynamoConnectionSubtree.tsx`).

This change is small and frontend-only. Issue #184 scopes it to DynamoDB.

## Goals / Non-Goals

**Goals:**
- Show the active AWS region in the identity header for focused DynamoDB connections.
- Prefer the runtime region (what the app is actually querying) over configured params; fall back to params when not active.
- Match `DESIGN.md` for the header metadata row; render as quiet metadata.
- Touch only the DynamoDB path; leave all other engines visually unchanged.

**Non-Goals:**
- Showing region for CloudWatch / Athena (out of scope for #184, even though the same mechanism would apply — see Open Questions).
- Any backend command, type, or schema change.
- Making the region interactive (click-to-edit, copy, etc.).

## Decisions

**Decision 1 — Resolve region in `ConnectionIdentityHeader`, gated by engine kind.**
Compute a `region` value only when `connection.kind === "dynamodb"`. Resolution order: `useActiveDynamoConnections().getActive(connectionId)?.region` first, then `connection.params.region` (the DynamoDB params) as fallback, else `null`. Render a region element in the `identityMeta` row only when `region` is truthy.

- *Why runtime-first:* the runtime region is the source of truth for what is being queried; params can drift if a connection was edited but not reconnected. The fallback keeps the chip useful before the connection is active.
- *Alternative considered — params-only:* simpler (no hook), but would show a region that may not match the live session. Rejected; the issue explicitly wants "the region of the active connection."
- *Alternative considered — a separate engine-dispatched header-meta component (mirroring `ConnectionHeaderActions`):* cleaner for future multi-engine expansion, but heavier than warranted for a single read-only string on one engine. Deferred; revisit if CloudWatch/Athena adopt the same treatment.

**Decision 2 — Reuse the existing `identityMeta` row; add one CSS class.**
Add a new `identityRegion` class in `WorkspaceShell.module.css` styled per `DESIGN.md` (same muted/secondary text treatment as `identityEngine`, consistent gap with the existing 5px row spacing). Keep DOM order: engine label → region → env dot, so the loudest signals frame the quieter region.

- *Why:* the row already exists and is correctly positioned; no layout restructuring needed.

**Decision 3 — Accessibility / display.**
Render the region as plain text with a `title` attribute (e.g. `AWS region: us-east-1`) so the abbreviated code is explained on hover, consistent with how the env dot uses `title`.

## Risks / Trade-offs

- [Active-connection hook timing: region briefly absent before the connection becomes active] → Params fallback covers this; if neither resolves, the chip is simply omitted (no flicker of an empty element).
- [Params shape access: reading `connection.params.region` requires the connection's params to be typed/narrowed for DynamoDB] → Guard on `connection.kind === "dynamodb"` before reading params; follow the existing pattern used elsewhere for engine-specific params access.
- [Header crowding on narrow sidebars] → Region is a short code (≤ ~14 chars); the row already truncates the name separately, so the meta row stays compact. Verify visually during QA.

## Open Questions

- Should CloudWatch and Athena later show their region in the header too, for cross-engine consistency? Same data is available. Out of scope for #184; if desired, generalize Decision 1 into an engine-dispatched header-meta resolver at that time.
