## Why

Argus today only speaks Postgres. The product thesis is multi-source from day one, and DynamoDB is the next data source on the roadmap (V2.1, change #9 in `openspec/ROADMAP-DYNAMO.md`). To make any of the Dynamo-specific features land (browse, view items, edit, PartiQL), we first need real DynamoDB connections — credentials wired through keychain or AWS profile/SSO, a working test-connection round-trip, an active client cache, region/endpoint config, and the read-only flag — all without touching a single line of Postgres code.

This change is the foundation of the Dynamo module. Once it ships, every later Dynamo change has somewhere to plug in.

## What Changes

- New `src/modules/dynamo/` and `src-tauri/src/modules/dynamo/` folders, **disjoint from `src/modules/postgres/`** — no shared editing, no copy-paste from Postgres.
- New Tauri commands: `dynamo.testConnection`, `dynamo.connect`, `dynamo.disconnect`, `dynamo.listActive`, `dynamo.listAwsProfiles`, `dynamo.updateCredentials`.
- New frontend connection form supporting two credential modes:
  - **Access keys**: `aws_access_key_id`, `aws_secret_access_key`, optional `aws_session_token` (STS short-lived creds).
  - **AWS profile**: dropdown of profiles read live from `~/.aws/credentials` and `~/.aws/config`, with SSO badge when the profile carries `sso_session`/`sso_start_url`.
- New fields on the form: `region` (required, dropdown), `endpoint_url` (optional, for DynamoDB Local / LocalStack / VPC endpoints), `read_only` toggle.
- Test connection uses `aws-sdk-sts::GetCallerIdentity` to validate credentials, measure latency, and return identity ARN + account ID.
- Active-client registry in Rust keyed by connection id, mirroring the Postgres `PgPoolRegistry` pattern in shape only, with `aws-sdk-dynamodb` clients instead of pools.
- Re-prompt flow when an `ExpiredToken*` is detected in access-keys-with-session-token mode: connection is marked `needs_credentials`, a toast surfaces, and the edit dialog opens pre-filled. New credentials replace old in keychain, the client is rebuilt, and pending operations retry. SSO-expired errors surface a copyable `aws sso login --profile <name>` command instead — Argus does not open browsers.
- Backend rejects mutating Dynamo operations when `read_only: true`. UI disables edit affordances and shows the existing RO badge.
- New AWS SDK dependencies in `src-tauri/Cargo.toml`: `aws-sdk-dynamodb`, `aws-sdk-sts`, `aws-config` (all pinned 1.x).
- Sidebar / `connection-registry` UI: the "+" affordance now opens a kind picker (Postgres vs DynamoDB) instead of going straight to the Postgres form. Connection rows dispatch to a kind-aware icon/form: Postgres rows keep their current behavior, Dynamo rows get a Dynamo icon and a Dynamo-specific form, dialog, and context menu wiring. **No Postgres code is modified beyond the kind dispatch in `app-shell`.**
- Palette commands `Connection: New DynamoDB…`, `Connection: Test… (DynamoDB)`, `Connection: Connect… (DynamoDB)`, `Connection: Disconnect… (DynamoDB)` registered alongside the existing Postgres palette commands.

## Capabilities

### New Capabilities

- `dynamo-connection`: Form, validation, test-connection, active-client registry, credentials lifecycle (including STS expiration re-prompt and SSO expiration messaging), region/endpoint handling, read-only enforcement, sidebar row rendering for Dynamo connections, palette command registration.

### Modified Capabilities

- `app-shell`: The sidebar "+" connection-creation flow becomes kind-aware. It no longer hardcodes `usePostgresForm()`; instead a kind picker opens the appropriate form. Connection rows dispatch icon and primary-click handlers by `kind` (`postgres` → Postgres path; `dynamodb` → Dynamo path; unknown → existing fallback text). Right-click context menu items remain kind-specific.

> Note: `connection-registry` is **not** listed as modified. The registry's `Connection envelope` requirement already declares `kind: string` with no enum, so accepting `"dynamodb"` is in-spec today. Params validation for the new kind lives in the new `dynamo-connection` capability, mirroring how `postgres-connection` owns Postgres params validation.

## Impact

- **Code**:
  - New: `src/modules/dynamo/` (form, controller, api, commands, icon, types, hooks, errors), `src-tauri/src/modules/dynamo/` (mod.rs, client.rs, commands.rs, params.rs, aws_profiles.rs, errors.rs).
  - Modified: `src/platform/shell/Sidebar.tsx` (kind picker for "+" menu), `src/platform/shell/ConnectionRow.tsx` (icon + click dispatch by kind), `src-tauri/src/lib.rs` (register new Dynamo commands in `invoke_handler!`).
  - **Not modified**: anything under `src/modules/postgres/**` or `src-tauri/src/modules/postgres/**`.
- **APIs**: 6 new Tauri commands under `dynamo.*`. No existing command signatures change.
- **Dependencies**: `aws-sdk-dynamodb`, `aws-sdk-sts`, `aws-config` (Rust). No new frontend deps; reuses existing form primitives, CodeMirror is not needed for this change.
- **Storage**: New `kind: "dynamodb"` rows in `connections` SQLite table. `params` JSON shape: `{ auth: "access_keys" | "profile", profile?: string, region: string, endpoint_url?: string, read_only: boolean, needs_credentials?: boolean }`. Keychain entries under the existing service/account convention (`argus` / `connection:<id>`) holding JSON `{ access_key_id, secret_access_key, session_token? }` when auth mode is `access_keys`; no keychain entry at all when auth mode is `profile` (SDK resolves credentials at call time).
- **Out of scope** (deferred to later changes or dropped per ROADMAP §9): refreshing SSO from inside the app, `role_arn` chaining / assume-role wizard, MFA interactive prompts, `credential_process` custom helpers, auto-refresh of session tokens via external brokers, listing tables (change #10), describing tables (change #10), any item read/write (changes #11/#12), PartiQL editor (change #13).
