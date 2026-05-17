# Security Policy

## Supported Versions

Only the latest released version of Argus receives security updates. See [releases](https://github.com/gsulloa/argus/releases) for the current version.

## Reporting a Vulnerability

Please **do not** open public GitHub issues for security vulnerabilities.

Instead, report them privately via either:

- GitHub's [private vulnerability reporting](https://github.com/gsulloa/argus/security/advisories/new) (preferred)
- Email: **gabriel.ulloa.e@gmail.com**

Include:

- A description of the issue and its impact
- Steps to reproduce (or a proof-of-concept)
- The affected version(s)
- Any suggested mitigations, if you have them

You should receive an initial response within **72 hours**. We aim to ship a fix or a documented mitigation within **14 days** for high-severity issues.

## Scope

In scope:

- The Argus desktop application (Tauri shell + Rust backend + React frontend)
- The release/update pipeline (`.github/workflows/release.yml`, the updater endpoint and signing flow)

Out of scope:

- Vulnerabilities that require physical access to an already-unlocked machine
- Issues in third-party dependencies that have not been published as a CVE (please report those upstream)
- Social engineering of maintainers
