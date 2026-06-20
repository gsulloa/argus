## Context

`.github/workflows/ci.yml` has a single `validate` job that only exercises the JS/TS workspace (`pnpm typecheck`, `pnpm lint`, `pnpm test:run`). The Rust/Tauri backend under `packages/app/src-tauri/` has no CI coverage, so clippy errors, formatting drift, and failing Rust tests can land undetected. `cargo clippy --all-targets` currently fails on `dev` because 4 test sites use π-approximating literals, which clippy's deny-by-default `approximate_constant` lint reports as errors. The crate also emits ~95 style warnings.

`release.yml` already shows the working recipe for building the crate on Linux: `dtolnay/rust-toolchain@stable` plus an apt install of `libwebkit2gtk-4.1-dev`, `libsoup-3.0-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `build-essential`, `curl`, `file`, `wget`.

## Goals / Non-Goals

**Goals:**
- `cargo clippy --all-targets` passes without errors locally and in CI.
- Every PR to `dev`/`master` runs Rust validation (`cargo fmt --check`, `cargo clippy --all-targets`, `cargo test`) and turns red if any fails.
- Rust validation is reasonably fast on repeat runs via cargo caching.

**Non-Goals:**
- Cleaning up the ~95 clippy style warnings.
- Enabling `-D warnings` (deferred until the style warnings are cleaned).
- Building, signing, notarizing, or publishing Tauri artifacts in CI (that stays in `release.yml`).

## Decisions

### Fix clippy errors by silencing in test code, not changing assertions
The 4 errors are in test code asserting float binding/coercion. Replace the π-approximating literals with non-π values where the exact value is irrelevant (e.g. `2.5`), OR add `#[allow(clippy::approximate_constant)]` on the specific test. Preferred: change the literal to a clearly non-constant value (`2.5_f64`, `json!(2.5)`) since the tests only assert "a float round-trips", keeping intent obvious without a lint-suppression annotation. The mysql `3.141592653589793` site is a "double precision" round-trip — replace with another full-precision non-π double (e.g. `2.718281828459045`).

_Alternative considered:_ blanket `#![allow(clippy::approximate_constant)]` at crate or module level — rejected as too broad; it would hide real future misuse.

### Add a separate Rust job rather than extending the existing `validate` job
Keep the JS/TS `validate` job untouched and add a parallel `rust` job. This isolates failures (a clippy error reads clearly as "rust" red, not buried in the JS job), lets the two jobs run concurrently, and keeps each job's caching simple (pnpm cache vs cargo cache). Both gate the PR.

_Alternative considered:_ append Rust steps to the existing job — rejected; serializes the two toolchains and muddies the cache and check semantics.

### Use `Swatinem/rust-cache` for cargo caching
The issue calls for it and it is the standard, low-config action for caching `~/.cargo` and `target/`, keyed on `Cargo.lock` and the workspace. Point it at `packages/app/src-tauri` via its `workspaces` input.

### Run clippy without `-D warnings` in v1
`cargo clippy --all-targets` already exits non-zero on the deny-by-default correctness/suspicious lints (which is what `approximate_constant` is), so the acceptance criterion "a PR that breaks clippy turns red" is met without escalating all ~95 style warnings to hard failures. Adding `-D warnings` now would require fixing all of them first; that is deferred.

_Alternative considered:_ `-D warnings` immediately — rejected for scope; would block this change on a large unrelated cleanup.

## Risks / Trade-offs

- **Rust CI job is slow on cold cache (full crate compile)** → mitigate with `Swatinem/rust-cache`; first run is slow, subsequent runs reuse `target/`. Acceptable for a per-PR gate.
- **Style warnings remain invisible in CI without `-D warnings`** → accepted for v1; tracked as an explicit follow-up. Correctness errors are still caught.
- **Apt deps / toolchain drift between `ci.yml` and `release.yml`** → keep the apt package list and toolchain action identical to `release.yml` so they stay in sync; note the duplication in the workflow.
- **New required check needs branch-protection wiring** → the new `rust` job reports a stable check name; enabling it as required in branch protection is a repo-settings step outside this change's files.
