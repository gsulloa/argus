# Contributing to Argus

Thanks for your interest in contributing. This guide covers everything you need to get started.

## Prerequisites

- **Rust toolchain** (stable) + Tauri 2 system dependencies — follow the official guide: https://tauri.app/start/prerequisites/
- **Node.js** (LTS)
- **pnpm** `10.33.0` — `npm install -g pnpm@10.33.0`

## Setup

```bash
pnpm install
```

## Development

```bash
pnpm tauri:dev   # starts Vite dev server + Tauri window
```

## Building

```bash
pnpm tauri:build
```

## Checks — run these before opening a PR

### Frontend

```bash
pnpm typecheck   # TypeScript type check (no emit)
pnpm lint        # ESLint
pnpm format      # Prettier (writes in place)
pnpm test:run    # Vitest (one-shot, for CI)
```

`pnpm test` runs Vitest in watch mode during development.

### Rust backend (`src-tauri/`)

```bash
cargo fmt
cargo clippy -- -D warnings
cargo test
```

All four frontend checks and all three Cargo checks must pass before a PR can merge.

## UI / visual changes

Read `DESIGN.md` first. Every font choice, color, spacing value, border radius, and motion decision must follow the design system defined there. PRs that deviate without explicit sign-off in the description will be asked to revise.

## Commit style

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(scope): add Athena export
fix: prevent crash on empty result set
chore: bump dependencies
docs: update README prerequisites
```

PR titles follow the same convention. Scope is optional but encouraged for larger areas (`ai`, `postgres`, `dynamo`, `athena`, `cloudwatch`, `context`, `ui`).

## Workflow

1. Fork the repo and create a feature branch off `master`.
2. Make your changes.
3. Ensure all frontend and Rust checks pass (see above).
4. Open a PR against `master` with a clear description of what changed and why.
5. Reference any related issue with `Closes #123` or `Relates to #123`.

## Security issues

Do **not** open a public issue for security vulnerabilities. Follow the private reporting process described in [SECURITY.md](./SECURITY.md).
