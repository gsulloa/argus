# Argus

A desktop tool for inspecting and editing data across multiple sources. V1 targets Postgres; V2+ adds DynamoDB and CloudWatch. Built on Tauri 2 (Rust backend + React frontend).

## Prerequisites

- **Node.js** 20+
- **pnpm** 10+
- **Rust** stable (install via [rustup](https://rustup.rs))
- **Platform tooling** for Tauri 2 — see the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/)
- **Linux only**: `libsecret` for OS keychain integration. On Debian/Ubuntu: `sudo apt install libsecret-1-dev`. Without it, secret storage fails at startup.

## Run

```sh
pnpm install
pnpm tauri:dev
```

## Build

```sh
pnpm tauri:build
```

The bundle lands under `src-tauri/target/release/bundle/`.

## Beta release pipeline

Beta builds are produced automatically by GitHub Actions on every merge to `master`,
signed and notarized for macOS, and distributed to the team via auto-updater. The
one-time setup (Apple Developer cert, R2 bucket, updater keypair, GH Secrets) is
documented in [docs/release-setup.md](docs/release-setup.md).

## Project layout

```
argus/
├── src/                    # React frontend
│   ├── app/                # top-level composition
│   ├── platform/           # shell, command palette, connection registry
│   ├── modules/            # data-source modules (empty in V1)
│   └── components/         # primitive UI atoms
└── src-tauri/              # Rust backend
    ├── src/
    │   ├── error.rs        # shared AppError enum
    │   └── platform/       # storage, secrets, connections
    └── migrations/         # SQLite migrations
```

## Data locations

- **SQLite database**: `<app_data_dir>/argus.db`
- **Secrets**: OS keychain under service `argus`, account `connection:<id>`
- **Logs (release)**: rotating files in `<app_log_dir>`
