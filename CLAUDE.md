# Argus

A Tauri 2 desktop app for inspecting and editing data across multiple sources.

## Supported Sources

- **PostgreSQL** — Full feature set: connection management, schema browser, virtualized data grid with inline editing, SQL editor, table structure viewer.
- **MySQL / MariaDB** — MySQL ≥ 5.7, MariaDB ≥ 10.5. Supports schema browsing, virtualized data grid with inline editing, SQL editor with multi-statement runs, table structure viewer.
- **Microsoft SQL Server** — SQL Server 2017+, Azure SQL Database, Azure SQL Managed Instance. Supports schema browsing, virtualized data grid with inline editing, SQL editor with `GO` batch support, table structure viewer. SQL Authentication only in v1.
- **DynamoDB** — Table browsing and item scanning.
- **Amazon CloudWatch Logs** — Log group / stream browsing and querying.

## Design System

Always read `DESIGN.md` before making any visual or UI decisions. All font choices, colors, spacing, border radii, motion, and aesthetic direction are defined there. Do not deviate without explicit user approval.

A live preview of the system rendered against the real Argus shell lives at `design/preview.html` — open it in a browser when you need to see how a token reads in context.

In QA or design-review mode, flag any code that doesn't match `DESIGN.md` (wrong fonts, wrong accent color, thick borders, decorative gradients, bubbly radii, AI-slop layouts).
