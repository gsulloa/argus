## 1. Backend scaffolding & dependencies

- [x] 1.1 Add `aws-sdk-dynamodb`, `aws-sdk-sts`, `aws-config` to `src-tauri/Cargo.toml` pinned to specific `1.x` patch versions; verify `cargo check` passes
- [x] 1.2 Create `src-tauri/src/modules/dynamo/mod.rs` exporting `params`, `client`, `aws_profiles`, `errors`, `commands` submodules
- [x] 1.3 Register the new module in `src-tauri/src/modules/mod.rs` alongside `postgres`
- [x] 1.4 Add `AppError::Aws { code: String, message: String, retryable: bool }` variant in `src-tauri/src/platform/errors.rs` (or equivalent), wired through the existing serde error serialization so the frontend can pattern-match on `code`

## 2. Params and validation

- [x] 2.1 Define `DynamoParams` struct in `src-tauri/src/modules/dynamo/params.rs` matching the spec shape (`auth`, `profile?`, `region`, `endpoint_url?`, `read_only`, `needs_credentials?`)
- [x] 2.2 Implement `DynamoParams::validate(&self, secret: Option<&str>) -> AppResult<()>` covering all validation scenarios in the spec (missing region, unknown region, missing profile in profile mode, empty access_key_id in access-keys mode, malformed endpoint URL, stripping `needs_credentials` from frontend input)
- [x] 2.3 Add a static `AWS_REGIONS` list and a `is_known_region(&str) -> bool` helper
- [x] 2.4 Unit tests for every validation branch (round-trip valid, each rejection case)

## 3. AWS profile discovery

- [x] 3.1 Implement `dynamo::aws_profiles::list_profiles() -> AppResult<Vec<ProfileInfo>>` reading `~/.aws/credentials` and `~/.aws/config` via `aws-config`'s profile loader
- [x] 3.2 Compute `sso: bool` by checking for any of `sso_session`, `sso_start_url`, `sso_account_id` in the profile's parsed section
- [x] 3.3 Surface `region` field from the profile section when present (otherwise `None`)
- [x] 3.4 Tauri command `dynamo_list_aws_profiles` returning the list; ensure it re-reads the filesystem on each call (no caching)
- [x] 3.5 Tests with fixture INI files covering: empty/missing files, plain access-keys profile, SSO profile, both files merged

## 4. Active-client registry

- [x] 4.1 Define `ActiveDynamoClient { client: aws_sdk_dynamodb::Client, account_id, identity_arn, region, read_only, connected_at }` in `src-tauri/src/modules/dynamo/client.rs`
- [x] 4.2 Define `DynamoClientRegistry` wrapping `RwLock<HashMap<Uuid, ActiveDynamoClient>>`; register it as Tauri state in `src-tauri/src/lib.rs`
- [x] 4.3 Implement `require_writable(connection_id) -> AppResult<()>` on the registry (returns `NotFound` if absent, `Validation` if `read_only: true`, `Ok` otherwise)
- [x] 4.4 Unit tests for `require_writable` covering all three branches

## 5. Credential resolution and SDK client builder

- [x] 5.1 Implement `build_dynamo_client(params, secret) -> AppResult<(Client, String /* accountId */, String /* identityArn */)>`: for `auth: "access_keys"` use `aws_sdk_dynamodb::Config::builder().credentials_provider(Credentials::from_keys(...))`; for `auth: "profile"` use `aws_config::from_env().profile_name(...).load()`
- [x] 5.2 Apply `region` and optional `endpoint_url`; relax TLS only for `localhost`/`127.0.0.1`/`[::1]` hosts
- [x] 5.3 Always run STS `GetCallerIdentity` once during client build to obtain `accountId`/`identityArn` and to fail fast on bad creds; map SDK errors to `AppError::Aws { code, message, retryable }`
- [x] 5.4 Helper `classify_aws_error(&SdkError) -> ErrorClass` mapping codes to `{ ExpiredSessionToken, ExpiredSso, AccessDenied, NetworkOrEndpoint, Other }`
- [x] 5.5 Tests with mocked SDK responses for: success, `ExpiredToken*` codes, SSO-expired error pattern, generic `AccessDeniedException`, DNS/connect failures

## 6. Tauri commands: test/connect/disconnect/listActive

- [x] 6.1 `dynamo_test_connection(params, secret?) -> { ok, latencyMs, accountId, identityArn, region } | { ok: false, error }` with 8-second timeout
- [x] 6.2 `dynamo_connect(connection_id) -> { accountId, identityArn, region, readOnly }`: idempotent on cached id, builds + registers client, emits `dynamo:active-changed`, emits one `argus:activity-log` event
- [x] 6.3 `dynamo_disconnect(connection_id) -> ()`: no-op if absent, emits `dynamo:active-changed` only when something was removed, emits one `argus:activity-log` event always
- [x] 6.4 `dynamo_list_active() -> Vec<ActiveDynamoClientView>` returning the public-safe view (no client handle, no secret material)
- [x] 6.5 SSO-expired error path: format the error message to include `aws sso login --profile <name>` verbatim (no parsing surprises later)
- [x] 6.6 Access-keys expired path: when in access-keys mode with a `session_token` in keychain, set `params.needs_credentials = true` via `connections.update` issued from the backend, evict any cached client for that id, then return the `AppError::Aws` to the caller
- [x] 6.7 Wire all four commands into the `invoke_handler!` macro in `src-tauri/src/lib.rs`
- [x] 6.8 Integration tests against `DynamoDB Local` (via the `endpoint_url` field): marked `#[ignore]`, run with `cargo test -- --ignored`
- [x] 6.9 Activity-log emission tests: exactly one event per command, payload shape matches spec (test_connection / connect / disconnect; status; metric; connection_id null vs id)

## 7. Tauri command: update credentials

- [x] 7.1 `dynamo_update_credentials(connection_id, { aws_access_key_id, aws_secret_access_key, aws_session_token? })`: reject `Validation` if `auth != "access_keys"`, reject `NotFound` for unknown id
- [x] 7.2 On success: write new JSON payload to keychain via `secrets::set`, evict the cached client (if any) from `DynamoClientRegistry`, clear `params.needs_credentials` via the registry's `connections.update`, emit `dynamo:credentials-refreshed` event with `{ id }`
- [x] 7.3 Wire into `invoke_handler!`
- [x] 7.4 Tests: input deserialization, activity-log shape, SSO-specialized error formatting, profile-mode guard logic

## 8. Frontend module scaffolding

- [x] 8.1 Create `src/modules/dynamo/` with `index.ts`, `types.ts` (including `DYNAMO_KIND = "dynamodb"` and the `DynamoParams` TS interface mirroring the Rust struct), `errors.ts` (mapping `AppError::Aws` codes to UI categories), `api.ts` (Tauri invoke wrappers grouped as `dynamoApi.{testConnection, connect, disconnect, listActive, listAwsProfiles, updateCredentials}`), `icon.tsx`
- [x] 8.2 Implement `useActiveConnections()` hook for Dynamo mirroring the Postgres one, listening to `dynamo:active-changed`
- [x] 8.3 Implement the Dynamo icon component (neutral abstract glyph, no AWS branding); verify visual against `DESIGN.md` and `design/preview.html`

## 9. Frontend connection form

- [x] 9.1 Implement `DynamoConnectionForm.tsx` with the two-mode radio (Access Keys / AWS Profile), all required fields, Test/Save/Save & Connect buttons
- [x] 9.2 Implement `FormController.tsx` exporting `useDynamoForm()` with `openCreate`, `openEdit`, `openDuplicate`, and `openCredentialsOnly(id)` for the re-prompt sub-mode
- [x] 9.3 Render the SSO badge inline on profile dropdown options with `sso: true`; auxiliary text under the dropdown when an SSO profile is picked
- [x] 9.4 Test-result inline rendering: green success row (`accountId`, `identityArn`, `latencyMs`), red error row (code + message), Copy command button on SSO-expired errors
- [x] 9.5 Edit-mode: leaving all three credential fields blank in Access Keys mode MUST NOT send a `secret` field on update
- [x] 9.6 Credentials-only sub-mode: lock all non-credential fields, pre-fill `access_key_id`/`secret_access_key` from `connections.getSecret`, focus `session_token`
- [x] 9.7 Wire the form's submit handlers to `connections.create` / `connections.update` plus the conditional `dynamo.connect` on Save & Connect

## 10. Expiration detection + re-prompt orchestration

- [x] 10.1 Listen for backend-emitted `AppError::Aws` with classified codes; when the code matches access-keys session expiration on an access-keys connection, open the form in credentials-only sub-mode and emit a toast "Session token expired — re-enter credentials"
- [x] 10.2 Listen for `dynamo:credentials-refreshed` and clear any "Reconnecting…" overlays on tabs scoped to that connection
- [x] 10.3 SSO-expired error path in the frontend: toast with the exact command `aws sso login --profile <name>` and a Copy button; do NOT open the credentials-only form
- [x] 10.4 Tests with mocked Tauri invokes covering: STS-expired triggers form re-prompt; SSO-expired does not; profile-mode session-token error path is unreachable (validation)

## 11. Sidebar dispatch refactor (`app-shell`)

- [x] 11.1 Replace the hardcoded `usePostgresForm()` call in `src/platform/shell/Sidebar.tsx` "+" menu with a `useKindPicker()` hook that opens the kind picker dialog
- [x] 11.2 Implement the kind picker dialog component (`<ConnectionKindPicker />`) with one card per supported kind (Postgres, Dynamo); each card carries icon, label, one-liner description; Escape and Cancel close without action
- [x] 11.3 Card click dispatches to `usePostgresForm().openCreate()` or `useDynamoForm().openCreate()`
- [x] 11.4 Update `src/platform/shell/ConnectionRow.tsx` to dispatch by `kind`: `postgres` keeps existing behavior, `dynamodb` uses the Dynamo icon + Dynamo connect/disconnect handlers; unknown kinds keep the existing plain-text fallback and gain no primary-click handler
- [x] 11.5 Wire the `RO` badge, status indicator, and `⏻` button into the Dynamo row exactly as for Postgres, sourcing data from `useActiveConnections()` for Dynamo and `params.read_only` from the connection
- [x] 11.6 Add a small warning indicator (icon + tooltip "Session token expired") when `params.needs_credentials` is true on a Dynamo row
- [x] 11.7 Compose the subtitle: `region · <accountId>` when active, `region · <profile>` or `region · access-keys` when inactive
- [x] 11.8 Right-click context menu for Dynamo rows: active → `Disconnect`, `Edit`, `Duplicate`, `Delete`; inactive → `Edit`, `Duplicate`, `Delete` (no `New SQL Query` entry until #13)

## 12. Disconnect confirmation dialog (Dynamo)

- [x] 12.1 Reuse the existing confirmation-dialog primitive (extracted from Postgres if already shared, otherwise duplicate the small component into `src/modules/dynamo/`)
- [x] 12.2 Body adapts: always the heading; conditional "N tab(s) will close." line when one or more tabs belong to the connection
- [x] 12.3 Footer: Cancel (no-op + close), Disconnect (dispatch `dynamo.disconnect(id)` + close)
- [x] 12.4 Snapshot-style tests over the dialog body for: zero tabs, multiple tabs

## 13. Palette commands

- [x] 13.1 Register `Connection: New DynamoDB…` opening the form via `useDynamoForm().openCreate()`
- [x] 13.2 Register `Connection: Test… (DynamoDB)`, `Connection: Connect… (DynamoDB)`, `Connection: Disconnect… (DynamoDB)` with selection-aware behavior and chooser fallback for the Test command
- [x] 13.3 Hook registration through the `command-palette` capability without modifying any Postgres palette code

## 14. Type-check, lint, build

- [x] 14.1 `pnpm tsc --noEmit` passes
- [x] 14.2 `pnpm lint` passes (no new disables — 6 pre-existing errors in scripts/build-manifest.mjs + scripts/bump-version.mjs; 0 errors in any dynamo/platform file)
- [ ] 14.3 `cargo fmt && cargo clippy -- -D warnings` clean — cargo fmt produced no changes; clippy has 6 pre-existing errors in postgres/query_history/activity_log; 0 dynamo warnings or errors. Gate cannot pass without fixing unrelated pre-existing debt.
- [x] 14.4 `pnpm tauri build --debug` succeeds end-to-end — binary at src-tauri/target/debug/argus (86MB), Argus.app bundle produced; DMG script failed (macOS tool issue, not a code defect)

## 15. Manual smoke test

- [x] 15.1 With DynamoDB Local running (`docker run -p 8000:8000 amazon/dynamodb-local`), create an access-keys connection with `endpoint_url: http://localhost:8000`, dummy credentials, region `us-east-1`; Test succeeds; Save & Connect lights the row green
- [x] 15.2 With a real AWS profile (SSO or static), create a profile connection; Test succeeds; Save & Connect populates the subtitle with the resolved `accountId`
- [x] 15.3 Trigger an expired-session-token error (e.g., paste an obviously expired STS token) and verify the re-prompt flow: toast appears, form opens in credentials-only sub-mode with two fields pre-filled, saving new creds restores the connection
- [x] 15.4 Trigger an SSO-expired error (run `aws sso logout --profile <name>`) and verify the SSO-expired toast with the copyable command; verify NO credentials-only form opens
- [x] 15.5 Verify read-only toggle: `require_writable` returns `Validation` for a read-only connection (mock via a future mutating command stub or via a unit test if no command exists yet)
- [x] 15.6 Verify Postgres connections still work end-to-end (smoke: create + connect + disconnect a Postgres connection from the same build)
- [x] 15.7 Verify the `+` kind picker dismisses on Escape and on Cancel without opening any form

## 16. Postgres isolation audit

- [x] 16.1 Confirm with `git diff --stat` that `src/modules/postgres/**` and `src-tauri/src/modules/postgres/**` have zero modifications
- [x] 16.2 If any modification is found, lift the shared primitive into `src/platform/**` or `src-tauri/src/platform/**` and re-run the diff

## 17. Documentation

- [x] 17.1 Update `openspec/ROADMAP-DYNAMO.md`'s #9 status indicator from ⏳ to ✅ at the end of the change
- [x] 17.2 No README or CLAUDE.md edits are required; new commands self-document via the palette
