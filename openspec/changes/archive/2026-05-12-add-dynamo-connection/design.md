## Context

Argus is a Tauri 2 desktop app. V1 shipped Postgres support (changes 1–8). The roadmap (`openspec/ROADMAP-DYNAMO.md`) frames DynamoDB as V2.1, with this change (#9) as the entry point. Decisions below resolve the open trade-offs the ROADMAP intentionally left to the proposal phase.

**Current state worth knowing**:

- `openspec/specs/connection-registry/spec.md` defines a permissive envelope: `kind` is an opaque `string`, `params` is opaque JSON, secrets live in OS keychain under `service: "argus"`, `account: "connection:<id>"`. The registry never interprets `params`. Source-specific modules (today only `postgres`) own validation, test, connect, disconnect, and read-only enforcement.
- `src-tauri/src/platform/secrets.rs` already implements a process-lifetime keychain cache with write-through and negative caching. We reuse it as-is.
- `src/modules/postgres/` and `src-tauri/src/modules/postgres/` are the templates we mirror in shape only — no shared editing, no copy-paste.
- `src/platform/shell/Sidebar.tsx` currently hardcodes `usePostgresForm()` on the "+" menu. Connection icon dispatch in `ConnectionRow.tsx` already has a fallback for unknown kinds (renders the kind as plain text), so unknown rows don't break.
- No `aws-sdk-*` crates are in `src-tauri/Cargo.toml` yet. No `src/modules/dynamo/` or `src-tauri/src/modules/dynamo/` exists yet.

**Constraints**:

- **Hard isolation from Postgres**: this change MUST NOT edit `src/modules/postgres/**` or `src-tauri/src/modules/postgres/**`. If a shared primitive is needed, lift it into `src/platform/**` or `src-tauri/src/platform/**`.
- The keychain cache is the only sanctioned path for secret bytes — Dynamo credentials go through the same `secrets::{get,set,delete,refresh}` API used by Postgres.
- DESIGN.md rules apply to any new UI surface.

## Goals / Non-Goals

**Goals:**

- A user can add a DynamoDB connection via the same `+` affordance that adds Postgres connections, picking either Access Keys or AWS Profile mode.
- Test-connection round-trips against AWS via STS `GetCallerIdentity` and surfaces latency + account/identity ARN, with crisp, kind-specific error messages for the two expiration scenarios that matter (STS session token vs. SSO cache).
- Save → Connect → see the row light up in the sidebar with a Dynamo icon and the same `RO` badge semantics Postgres uses.
- The Postgres module is byte-for-byte unchanged.
- A future change (#10 `browse-dynamo-tables`) can plug into the active-client registry without re-architecting anything.

**Non-Goals:**

- Listing or describing tables (deferred to #10).
- Reading or writing items, PartiQL editor (deferred to #11–#13).
- Refreshing SSO from inside the app (would require browser-driven device-code flow — explicitly deferred).
- Assume-role chaining (`role_arn` in profile, `sts:AssumeRole` MFA prompts) — deferred until a real user asks for it.
- `credential_process` custom helpers — deferred.
- Auto-refresh of session tokens via external brokers — deferred. We surface a re-prompt instead.
- A generic "connection kind selector" framework that auto-discovers modules from a registry. We hardcode the two known kinds (`postgres`, `dynamodb`) in `app-shell`'s "+" picker. A registry-style design is premature for two kinds and would push us toward dynamic imports we don't need.

## Decisions

### D1 — Two credential modes only (Access Keys, AWS Profile)

Per ROADMAP §"Credenciales". The form has a top-level radio: **Access Keys** (`{ aws_access_key_id, aws_secret_access_key, aws_session_token? }`) or **AWS Profile** (single dropdown). No third mode. SSO is **not** a third mode — a profile with `sso_session` or `sso_start_url` is just an AWS-Profile entry with a visual `SSO` badge.

**Alternatives considered**:

- A "magic" mode that auto-detects the default credential chain (`AWS_PROFILE`, env vars, instance profile). Rejected: it makes the saved connection's behavior depend on the user's shell at connect time, which is anti-deterministic for a stored config. Users who want that can pick the relevant profile.
- A separate "SSO" mode. Rejected: from the SDK's perspective SSO is resolved through the profile cache; doubling the UI just to badge it is noise.

### D2 — Region is a first-class field, not derived from profile

Region is required, dropdown-selected, stored in `params.region`. A profile's default region pre-fills the dropdown when the user picks a profile but the dropdown remains editable. This matches ROADMAP §"Región" and the product-level reason: forcing duplicate profiles to switch region is engineer-UX, not product-UX.

**Implementation note**: regions are a static list shipped with the build (`AWS_REGIONS` const). Refreshable when AWS publishes new regions — not at runtime, just at the next Argus release.

### D3 — Endpoint URL is opt-in text input, TLS strict outside loopback

`params.endpoint_url` is an optional string. When set, it's passed to the SDK builder as a `endpoint_url`. TLS verification is relaxed **only** when the host parses as `localhost`/`127.0.0.1`/`[::1]` — every other endpoint (corporate proxies, VPC endpoints) goes through normal TLS validation. Validation rejects malformed URLs at form submit time.

**Alternative considered**: a "skip TLS" checkbox. Rejected: that's an explosive footgun for any non-localhost target and there's no real-world Dynamo deployment that benefits.

### D4 — Active-client registry is a `DynamoClientRegistry` parallel to `PgPoolRegistry`

Backend cache structure: `RwLock<HashMap<Uuid, ActiveDynamoClient>>` where `ActiveDynamoClient` holds the SDK client plus the resolved `region`, `account_id`, `identity_arn`, and `read_only` snapshot. Same lifecycle as `PgPoolRegistry`: `connect(id)` builds it (idempotent — returns cached on second call), `disconnect(id)` removes it. Stored in Tauri's app state via `tauri::State`. **Not shared with `PgPoolRegistry`** — separate file, separate type, separate state slot. No premature abstraction.

**Alternative considered**: A generic `ClientRegistry<T>` trait covering both Postgres pools and Dynamo clients. Rejected — two implementations is not enough to design an abstraction. Wait until #14+ (CloudWatch) before generalizing.

### D5 — STS-based test-connection (not a `ListTables` ping)

`dynamo.testConnection` builds an `aws-sdk-sts` client with the same credential resolver the eventual Dynamo client would use, then calls `GetCallerIdentity()`. Returns `{ ok: true, latencyMs, identityArn, accountId, region }` or `{ ok: false, error: AppError }`.

**Why STS, not DynamoDB `ListTables`**:

- `GetCallerIdentity` requires only `sts:GetCallerIdentity` (granted by default to any valid principal), so it succeeds even on tightly-scoped IAM users that lack `dynamodb:ListTables`.
- It also returns the account ID and identity ARN, which we surface to the user as test-result feedback ("Logged in as: arn:aws:iam::123456789012:user/argus-readonly").

**Tradeoff**: a successful STS call does not prove the user can talk to DynamoDB. We accept this — the next call (`dynamo.connect`) will surface DynamoDB-specific errors at its first usage in #10. The alternative (testing with `ListTables`) would falsely fail on locked-down IAM users that can still read specific tables via item-level commands.

### D6 — Error taxonomy and the STS-expiration re-prompt

We define a new `AppError::Aws { code: String, message: String, retryable: bool }` variant for SDK-originated errors. We surface specific UX paths for three error codes:

1. `ExpiredToken` / `ExpiredTokenException` / `InvalidClientTokenId` **AND** auth mode is `access_keys` with a session token in keychain → mark connection `needs_credentials = true`, emit toast "Session token expired", open the form in "credentials only" sub-mode (other fields read-only, focus on session token), pre-load the existing `access_key_id` and `secret_access_key` from keychain. On save: replace keychain entry, evict cached client, clear `needs_credentials`, retry the failing operation. Open tabs do NOT close.
2. SSO-related codes (`AccessDeniedException` with `Token has expired`, plus the SDK's own `SsoTokenProviderError`-shaped errors) when auth mode is `profile` and the profile is SSO-flavored → emit a non-retryable error with body "Run `aws sso login --profile <name>` in your terminal, then try again", plus a "Copy command" button. Argus does not open a browser. The connection is NOT marked `needs_credentials` (nothing to fix in Argus state).
3. All other AWS errors → surface raw error message + code with a generic toast.

**Alternatives considered**:

- Auto-refreshing tokens via a broker process — too platform-specific (different brokers per org) and out of V2.1 scope.
- Opening a browser to run the SSO device flow ourselves — possible but requires a real session-management subsystem (PKCE state, callback server, multi-window orchestration). Defer until the request volume justifies the engineering.
- Closing tabs on `needs_credentials` to "reset" state — rejected. Users expect their open work to survive credential refresh. Tabs that need a Dynamo client get a "Reconnecting…" overlay; once new creds land, their queued operations retry.

### D7 — `aws.listProfiles()` reads filesystem at call time

`dynamo.listAwsProfiles()` reads `~/.aws/credentials` and `~/.aws/config` on every call (no caching at this layer — caching is a UI concern). Returns `Array<{ name: string, sso: boolean, region?: string }>`. `sso` is `true` iff the profile section contains `sso_session`, `sso_start_url`, or `sso_account_id`. Region is whatever the profile declares as `region` (we don't follow `source_profile` chains in V2.1 — that's an explicit non-goal).

**Why no cache**: profile files are tiny; reading them on each open of the form is fast. Stale UI is worse than redundant I/O here.

### D8 — Keychain payload shape for access-keys mode

When `auth: "access_keys"`, the keychain entry holds JSON-encoded `{ access_key_id: string, secret_access_key: string, session_token?: string }`. When `auth: "profile"`, there is **no keychain entry at all**: the SDK resolves credentials at call time using the stored profile name. This means `connections.getSecret(id)` returns `null` for profile-mode connections, and the Dynamo client builder branches on `params.auth` to decide whether to call `getSecret`.

**Alternative considered**: store the profile name in the keychain too "for symmetry". Rejected: there's no secret in profile mode, and keychain prompts (on macOS, the user gets prompted on first read of a new keychain entry) for a non-secret value would be confusing.

### D9 — `app-shell` "+" picker is a small typed dispatch

The Sidebar's "+" menu's "New connection" item opens a tiny picker dialog with two cards: "PostgreSQL" and "DynamoDB". Each card has the kind's icon, name, and a one-line description. Clicking a card opens that kind's form (`usePostgresForm().openCreate()` or `useDynamoForm().openCreate()`). The picker is a one-liner refactor — we do not introduce a plugin-registry pattern here. When kind #3 lands (CloudWatch), we revisit whether a registry is worth it.

**Alternative considered**: a tabbed form ("Postgres / Dynamo" tabs at the top of a single dialog). Rejected — the two forms have completely different fields and validation, so a tab control creates a maintenance burden disguised as UX symmetry.

### D10 — Read-only enforcement lives in the client builder

Mutating commands (`putItem`, `updateItem`, `deleteItem`, PartiQL non-SELECT) ship in later changes. For #9, we still define the contract: the active-client envelope carries the `read_only: bool` snapshot at connect time, and every future Dynamo mutation command MUST check it before dispatching to the wire. We codify the check helper (`require_writable(id) -> AppResult<()>`) in this change so #11/#12/#13 just call it. UI side: the form's `read_only` toggle defaults to **false** (matches Postgres semantics), and the rendered sidebar row gets the existing `RO` badge component when true.

### D11 — Activity log integration

Same pattern as Postgres: `dynamo.testConnection`, `dynamo.connect`, `dynamo.disconnect` each emit exactly one `argus:activity-log` event with `kind` matching the command (`test_connection`, `connect`, `disconnect`), `connection_id` populated for connect/disconnect (null for testConnection), and `metric` set as follows:

- `testConnection` success → `{ kind: "aws_identity", value: "<accountId>:<identityArn>" }`
- `connect` success → `{ kind: "aws_identity", value: "<accountId>:<identityArn>" }`
- `disconnect` always → `null`

This keeps the activity log queryable across sources without adding new metric kinds for every source.

### D12 — Tauri command naming

All Dynamo backend commands use `snake_case` Rust function names exposed as `dynamo_*` to the frontend (matching the existing `postgres_*` convention in `lib.rs`'s `invoke_handler!`). Frontend wrapper functions in `src/modules/dynamo/api.ts` group them under a `dynamoApi` object for ergonomics, paralleling `postgresApi`.

## Risks / Trade-offs

- **[STS test-connection passes but real DynamoDB calls fail with `AccessDenied`]** → Mitigation: surface a one-time toast on first failed DynamoDB call after a successful test-connection explaining "STS passed, but DynamoDB returned AccessDenied — the principal `<identityArn>` lacks the required action. Check IAM." This toast lives in #10 (where `ListTables` first happens), not #9, but we note the contract here so #10 doesn't have to re-derive it.
- **[Adding 3 AWS SDK crates inflates binary size]** → Mitigation: `aws-sdk-dynamodb`, `aws-sdk-sts`, and `aws-config` together add ~15–20 MB to the binary. We accept this; multi-source is a core product bet and the Tauri binary is not size-constrained for desktop distribution today.
- **[SDK version churn]** → Mitigation: pin all three crates to a specific `1.x` patch version in `Cargo.toml` (no `^1` wildcards). Bumps happen in a separate change and are not bundled with feature work.
- **[Profile parser drifts from real `~/.aws/config` semantics]** → Mitigation: we use `aws-config`'s own profile loader rather than hand-rolling INI parsing. If `aws-config` says a profile exists, the SDK will accept it.
- **[Keychain prompts on macOS for first secret write per session]** → This is system behavior, not a code-level risk; we surface a one-line hint in the form when the user first picks Access Keys mode: "macOS will ask for keychain access when saving."
- **[Re-prompt dialog UX is fiddly]** → The "credentials only" sub-mode of the dialog re-uses the same component as the full form, gated by a prop. Risk: forms with that prop become a tangle. Mitigation: when the form-controller grows past ~150 lines, we split `DynamoConnectionForm` and `DynamoCredentialsForm` into separate components. Not a Day-1 concern.
- **[Race between `updateCredentials` and a queued retry of the failing operation]** → The retry path is opt-in: after `updateCredentials` succeeds, we emit a `dynamo:credentials-refreshed` event carrying the connection id. Tabs that were paused on `needs_credentials` listen and reissue their own last failed call. We do not orchestrate retries from the backend.

## Migration Plan

- **Schema**: No SQLite migration. The existing `connections` table already has a generic `params` JSON column and accepts any `kind` string. We do bump the `_migrations` version only if we discover a missing index — but baseline plan is no migration.
- **Backward compat**: Existing Postgres connections are entirely untouched. Users with `argus.db` upgrade in place. The first launch after this ships shows an empty `+` picker entry for DynamoDB.
- **Rollback**: If we ship and need to roll back, we ship the previous binary. SQLite rows of `kind: "dynamodb"` written by the new binary will appear with the fallback text label in the old sidebar (because of the existing unknown-kind fallback) — they remain harmless and can be re-deleted by the user. We will note this in the release notes if a rollback ever happens.
- **Feature flag**: Not used. The "+" picker showing two cards is harmless even if the Dynamo path is unfinished; we don't ship until #9 is end-to-end working.

## Open Questions

- (Resolvable in tasks phase) Should the Dynamo icon be vendor-y (orange AWS Dynamo cube) or a neutral abstract glyph that matches our `DESIGN.md` aesthetic? Default plan: neutral abstract glyph (a stylized "D" or a partition-key motif), confirmed against `DESIGN.md` and `design/preview.html` before committing pixels.
- (Resolvable in tasks phase) Where do we surface the `account_id` and `identity_arn` in the sidebar row's subtitle? The roadmap says "as subtitle of the connection (like `db_name@host` in Postgres)" — we'll mirror that exactly: `region · <accountId>` as the subtitle for active connections, `region · <profile_name|access_keys>` for inactive ones.
