## 1. Fix clippy approximate_constant errors

- [x] 1.1 In `packages/app/src-tauri/src/modules/athena/sql.rs:638`, replace `3.14_f64` (and the matching `"3.14"` input string) with a non-π float (`2.5`) so the round-trip assertion still holds
- [x] 1.2 In `packages/app/src-tauri/src/modules/mssql/binding.rs:873`, replace `serde_json::json!(3.14)` with a non-π float (`json!(2.5)`)
- [x] 1.3 In `packages/app/src-tauri/src/modules/mysql/binding.rs:994`, replace `serde_json::json!(3.14)` with a non-π float (`json!(2.5)`)
- [x] 1.4 In `packages/app/src-tauri/src/modules/mysql/binding.rs:1001`, replace `serde_json::json!(3.141592653589793)` with a non-constant double (`json!(1.234567890123456)` — note `e` = `2.718…` is also a clippy-flagged constant, so avoided)
- [x] 1.5 `cargo clippy --all-targets` confirmed zero errors (style warnings still emitted, allowed)
- [x] 1.6 `cargo test` — the 4 edited tests pass. Full `--lib` suite: 1303 passed, 1 preexisting flaky keychain test (`ai::*::validate_returns_missing_when_no_key`) fails only under parallel execution due to shared OS-keychain global state; passes single-threaded. Unrelated to this change.

## 2. Add Rust validation job to CI

- [x] 2.1 In `.github/workflows/ci.yml`, added a `rust` job running on `ubuntu-latest`, triggered by the existing `pull_request` config (dev/master)
- [x] 2.2 Added steps: checkout, `dtolnay/rust-toolchain@stable` with `components: clippy, rustfmt`
- [x] 2.3 Install Tauri Linux deps via apt, matching `release.yml` (`libwebkit2gtk-4.1-dev`, `libsoup-3.0-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `build-essential`, `curl`, `file`, `wget`)
- [x] 2.4 Added `Swatinem/rust-cache@v2` scoped to `packages/app/src-tauri` (`workspaces` input)
- [x] 2.5 Added run steps against the crate (via job `working-directory`), in order: `cargo fmt --check`, `cargo clippy --all-targets`, `cargo test` (each fails the job on non-zero exit)
- [x] 2.6 The `rust` job has a stable, distinct check name (`name: rust`) for branch-protection reference

## 3. Verify

- [x] 3.1 Validated the workflow YAML parses; the two jobs (`validate`, `rust`) are independent and the rust steps are ordered fmt → clippy → test
- [x] 3.2 Manually tested (per user); PR opened to `dev` so both the JS/TS `validate` check and the new `rust` check run and report status
- [x] 3.3 Confirmed clippy exits non-zero on errors: the 4 `approximate_constant` errors made `cargo clippy` exit 1 before the fix; it exits 0 after. The CI clippy step therefore turns red on any clippy error.

## Note / follow-up

- Ran `cargo fmt` across the whole crate (33 files reformatted) so the new `cargo fmt --check` CI step passes — preexisting rustfmt drift, unrelated to the clippy fix (per user decision during apply).
- Follow-up (out of scope): clean the ~93 clippy style warnings, then enable `-D warnings`; and fix the keychain-test parallel-execution flakiness so the CI `cargo test` step is reliable.
