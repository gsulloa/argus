## Why

`cargo clippy --all-targets` fails today with correctness-class errors (`clippy::approximate_constant`) that are preexisting in `dev` and went undetected because CI only validates the JS/TS workspace — nothing on the Rust side runs in CI. As a result, the Rust backend can regress (broken clippy, formatting, or tests) without any PR turning red.

## What Changes

- Fix the 4 `clippy::approximate_constant` errors in Rust test code so `cargo clippy --all-targets` passes without errors:
  - `packages/app/src-tauri/src/modules/athena/sql.rs:638` (`3.14_f64`)
  - `packages/app/src-tauri/src/modules/mssql/binding.rs:873` (`json!(3.14)`)
  - `packages/app/src-tauri/src/modules/mysql/binding.rs:994` (`json!(3.14)`)
  - `packages/app/src-tauri/src/modules/mysql/binding.rs:1001` (`json!(3.141592653589793)`)
- Extend `.github/workflows/ci.yml` so PRs to `dev`/`master` also validate the Rust backend: a job that installs the Rust toolchain + Tauri system deps (with `Swatinem/rust-cache`) and runs `cargo fmt --check`, `cargo clippy --all-targets`, and `cargo test`.
- Clippy runs **without** `-D warnings` in v1: the existing ~95 style warnings (e.g. `too many arguments`, `manual str::repeat`, unused imports) are out of scope and tracked as a follow-up. The default clippy run already exits non-zero on the correctness/suspicious errors, so a PR that breaks clippy turns red without escalating every style warning to an error.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `ci-pr-validation`: add a requirement that the PR validation workflow also validates the Rust/Tauri backend (`cargo fmt --check`, `cargo clippy --all-targets`, `cargo test`) on PRs to `dev`/`master`, in addition to the existing JS/TS steps.

## Impact

- **CI**: `.github/workflows/ci.yml` gains a Rust validation job (toolchain setup, Tauri apt deps on `ubuntu-latest`, cargo cache). PR check surface grows; branch protection may reference the new check.
- **Rust code**: 3 test files edited to remove π-approximation literals (`athena/sql.rs`, `mssql/binding.rs`, `mysql/binding.rs`). No runtime/production code behavior changes.
- **Follow-up (out of scope)**: clean up the ~95 clippy style warnings and then enable `-D warnings` in CI.
