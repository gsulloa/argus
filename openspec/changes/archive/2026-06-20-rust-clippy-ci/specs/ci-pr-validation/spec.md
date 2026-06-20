## MODIFIED Requirements

### Requirement: PR validation workflow runs typecheck, lint, and tests on PRs to dev and master

The repository SHALL include a GitHub Actions workflow at `.github/workflows/ci.yml` triggered on `pull_request` events targeting the `dev` and `master` branches. The workflow MUST run a JS/TS validation job on `ubuntu-latest` and execute these steps in order, failing the job on the first non-zero exit:

1. Check out the PR head.
2. Set up pnpm via `pnpm/action-setup` (the workflow MUST NOT pin a pnpm version inline; the version is resolved from the root `package.json` `packageManager` field, currently `pnpm@10.33.0`).
3. Set up Node 22 via `actions/setup-node` with `cache: pnpm` (matching `release.yml`).
4. Install dependencies with `pnpm install --frozen-lockfile`.
5. Run `pnpm typecheck`.
6. Run `pnpm lint`.
7. Run `pnpm test:run`.

The workflow MUST NOT build Rust/Tauri artifacts, sign, notarize, or publish anything — beyond linting and testing the Rust backend (see the Rust backend validation requirement), it does not produce or release build artifacts. The JS/TS job MUST report a single, stable check name so it can be referenced as a required status check in branch protection.

#### Scenario: PR with passing checks is green

- **WHEN** a contributor opens or updates a pull request targeting `dev` or `master` and the workspace passes `pnpm typecheck`, `pnpm lint`, and `pnpm test:run`
- **THEN** the `ci.yml` workflow runs on `ubuntu-latest`, completes successfully, and reports a passing status check on the PR

#### Scenario: A type error fails the PR check

- **WHEN** a pull request introduces a TypeScript type error that makes `pnpm typecheck` exit non-zero
- **THEN** the workflow fails at the typecheck step, does not run lint or tests, and reports a failing status check on the PR

#### Scenario: A lint or test failure fails the PR check

- **WHEN** a pull request passes typecheck but `pnpm lint` or `pnpm test:run` exits non-zero
- **THEN** the workflow fails at the corresponding step and reports a failing status check on the PR

#### Scenario: Workflow does not trigger outside dev/master PRs

- **WHEN** a pull request targets a branch other than `dev` or `master`, or a push occurs without an associated PR to those branches
- **THEN** the `ci.yml` workflow does not run

#### Scenario: Dependency install uses the frozen lockfile

- **WHEN** a pull request changes `package.json` without updating `pnpm-lock.yaml`
- **THEN** `pnpm install --frozen-lockfile` fails the job, surfacing the lockfile drift before merge

## ADDED Requirements

### Requirement: PR validation workflow validates the Rust/Tauri backend

The `.github/workflows/ci.yml` workflow SHALL include a Rust validation job that runs on `ubuntu-latest` for `pull_request` events targeting `dev` and `master`. The job MUST:

1. Check out the PR head.
2. Install the stable Rust toolchain (via `dtolnay/rust-toolchain@stable`) including the `clippy` and `rustfmt` components.
3. Install the Tauri Linux system dependencies required to compile the crate, matching `release.yml` (`libwebkit2gtk-4.1-dev`, `libsoup-3.0-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `build-essential`, `curl`, `file`, `wget`).
4. Cache cargo registry/git and the `target/` directory via `Swatinem/rust-cache` scoped to `packages/app/src-tauri`.
5. Run, against the `packages/app/src-tauri` crate, failing the job on the first non-zero exit: `cargo fmt --check`, then `cargo clippy --all-targets`, then `cargo test`.

The Rust job MUST report a stable check name distinct from the JS/TS job so it can be referenced independently as a required status check. The Rust job MUST NOT build, sign, notarize, or publish Tauri release artifacts. In v1 the clippy invocation MUST NOT pass `-D warnings`; it relies on clippy's deny-by-default lint groups so that a PR introducing a clippy error turns the check red while preexisting style warnings do not fail the job.

#### Scenario: PR with a passing Rust backend is green

- **WHEN** a pull request targets `dev` or `master` and the crate passes `cargo fmt --check`, `cargo clippy --all-targets`, and `cargo test`
- **THEN** the Rust job runs on `ubuntu-latest`, completes successfully, and reports a passing status check on the PR

#### Scenario: A clippy error fails the PR check

- **WHEN** a pull request introduces a clippy correctness/suspicious error (e.g. `clippy::approximate_constant`) that makes `cargo clippy --all-targets` exit non-zero
- **THEN** the Rust job fails at the clippy step and reports a failing status check on the PR

#### Scenario: A formatting or test failure fails the PR check

- **WHEN** a pull request leaves Rust code unformatted (so `cargo fmt --check` exits non-zero) or breaks a Rust test (so `cargo test` exits non-zero)
- **THEN** the Rust job fails at the corresponding step and reports a failing status check on the PR

#### Scenario: Preexisting style warnings do not fail the check

- **WHEN** the crate emits clippy style warnings that are not deny-by-default errors and the PR introduces no clippy errors, formatting drift, or test failures
- **THEN** the Rust job completes successfully, because clippy runs without `-D warnings`
