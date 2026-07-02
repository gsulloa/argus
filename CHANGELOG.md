# Changelog

All notable changes to Argus are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0/).

## [Unreleased]

## [0.7.5] - 2026-07-01

### Added
- App-wide surfacing of clipboard copy failures so users know when a copy did not reach the clipboard ([#217](https://github.com/gsulloa/argus/pull/217))

## [0.7.4] - 2026-07-01

### Added
- Copy rows with ⌘C and select rows via the row-number gutter in the data grid ([#215](https://github.com/gsulloa/argus/pull/215))

## [0.7.3] - 2026-06-30

### Fixed
- Postgres saved queries now open reliably via `initialConnectionId` routing ([#211](https://github.com/gsulloa/argus/pull/211))
- Connection Manager group drag-and-drop reorders groups reliably with scoped collision detection ([#210](https://github.com/gsulloa/argus/pull/210))

## [0.7.2] - 2026-06-29

### Changed
- Connection Manager window is now fixed at 760×600 and non-resizable ([#206](https://github.com/gsulloa/argus/pull/206))

## [0.7.1] - 2026-06-29

### Added
- Copy a selected row range to the clipboard as TSV ([#200](https://github.com/gsulloa/argus/pull/200))
- Cancel a running query from the SQL editor toolbar ([#202](https://github.com/gsulloa/argus/pull/202))
- RAW SQL filter row in the Postgres data grid for jsonb columns and free-form predicates ([#203](https://github.com/gsulloa/argus/pull/203))
- Right-click context menu for row and cell actions in the data grid ([#199](https://github.com/gsulloa/argus/pull/199))

### Changed
- Enter now applies only the focused filter row; Shift+Enter applies all filter rows ([#204](https://github.com/gsulloa/argus/pull/204))

### Fixed
- PK-detection failure no longer blocks inline editing ([#201](https://github.com/gsulloa/argus/pull/201))

## [0.7.0] - 2026-06-24

### Added
- User-assignable colors to connections for visual identification in the sidebar ([#188](https://github.com/gsulloa/argus/pull/188))
- Cmd+A selects all rows when a row selection is already active in the data grid ([#186](https://github.com/gsulloa/argus/pull/186))
- AWS region shown in the workspace header for DynamoDB connections ([#190](https://github.com/gsulloa/argus/pull/190))

### Changed
- Saved queries are now unified with the context folder, making them part of the project ([#187](https://github.com/gsulloa/argus/pull/187))

### Fixed
- Filter inputs no longer discard typed text on numeric columns in the Postgres data grid ([#191](https://github.com/gsulloa/argus/pull/191))

## [0.6.1] - 2026-06-22

### Added
- Connection form and feedback panel open in dedicated windows ([#177](https://github.com/gsulloa/argus/pull/177))

### Fixed
- Context-folder link state is now reflected live in the connection form ([#176](https://github.com/gsulloa/argus/pull/176))

## [0.6.0] - 2026-06-21

### Added
- Amazon CloudWatch Logs support: connection setup, log-group and stream browser, Logs Insights editor with async query lifecycle, dynamic columns, cost display, and CSV/JSONL/XLSX export
- In-app feedback tracker backed by a serverless AWS backend ([#171](https://github.com/gsulloa/argus/pull/171))
- AI chat panel in the CloudWatch Logs Insights editor ([#170](https://github.com/gsulloa/argus/pull/170))
- Per-engine contextual actions in the workspace identity header ([#167](https://github.com/gsulloa/argus/pull/167))
- Connection engine type label shown in the SQL editor connection selector ([#165](https://github.com/gsulloa/argus/pull/165))

## [0.5.1] - 2026-06-20

### Added
- Free-form PartiQL query editor for DynamoDB connections ([#161](https://github.com/gsulloa/argus/pull/161))

## [0.5.0] - 2026-06-20

### Added
- Diff-aware smart schema resync — only changed objects are rewritten to the context folder ([#162](https://github.com/gsulloa/argus/pull/162))
- Athena Named Queries CRUD: create, update, and delete saved queries directly from the sidebar ([#160](https://github.com/gsulloa/argus/pull/160))
- Schema and table trees are cached across connection switches with a 1-hour TTL and ⌘R refresh ([#159](https://github.com/gsulloa/argus/pull/159))
- Confirmation prompt before discarding pending edits on data grid refresh ([#157](https://github.com/gsulloa/argus/pull/157))

## [0.4.0] - 2026-06-20

### Added
- Dual-window shell: dedicated Connection Manager window alongside the Workspace ([#152](https://github.com/gsulloa/argus/pull/152))

## [0.3.2] - 2026-06-19

### Added
- Refresh available AI models from within the provider configuration dialog ([#142](https://github.com/gsulloa/argus/pull/142))

### Fixed
- Postgres data grid now allows assigning NULL to nullable editable columns ([#149](https://github.com/gsulloa/argus/pull/149))

## [0.3.1] - 2026-06-19

- Maintenance and fixes

## [0.3.0] - 2026-06-19

### Added
- Athena Named Queries discovered from the account now appear in the sidebar ([#138](https://github.com/gsulloa/argus/pull/138))
- GitHub Releases created automatically on each version tag ([#130](https://github.com/gsulloa/argus/pull/130))
- Default table view now sorts by primary key descending ([#132](https://github.com/gsulloa/argus/pull/132))
- Row click auto-opens the inspector panel in MySQL and MSSQL data grids ([#131](https://github.com/gsulloa/argus/pull/131))
- Windows and Linux download options on the landing page ([#127](https://github.com/gsulloa/argus/pull/127))

## [0.2.1] - 2026-06-18

### Fixed
- Table quick-switcher now scrolls the best match into view on search ([#129](https://github.com/gsulloa/argus/pull/129))

## [0.2.0] - 2026-06-17

### Added
- Amazon Athena support: serverless SQL over S3, Glue-backed schema browser, async query lifecycle, cost display, and CSV/JSONL/XLSX export ([#87](https://github.com/gsulloa/argus/pull/87))
- AI agent can document context-folder object docs from the chat panel ([#100](https://github.com/gsulloa/argus/pull/100))
- Attach executed query results to AI chat as context (capped at 100 rows / 50 KB) ([#77](https://github.com/gsulloa/argus/pull/77))
- AI chat setup readiness indicator and home onboarding checklist ([#75](https://github.com/gsulloa/argus/pull/75))
- DynamoDB filter-by-model for Single-Table Design with SK filters and model editor ([#84](https://github.com/gsulloa/argus/pull/84))
- DynamoDB logical-name matching for CDK-style physical table names across environments ([#86](https://github.com/gsulloa/argus/pull/86))
- Copy single cell value with ⌘C across all engines ([#95](https://github.com/gsulloa/argus/pull/95))
- Per-connection context folder path stored as local state ([#99](https://github.com/gsulloa/argus/pull/99))
- Argus landing page published at argusdb.app ([#111](https://github.com/gsulloa/argus/pull/111))

### Fixed
- Cmd+S saves reliably across all engines in the data edit flow ([#93](https://github.com/gsulloa/argus/pull/93))
- Client-side sorting of SQL editor query results works across all engines ([#92](https://github.com/gsulloa/argus/pull/92))
- Schema tree no longer hangs on reserved-word table names ([#69](https://github.com/gsulloa/argus/pull/69))
- Re-applying the same filter now refetches data correctly ([#67](https://github.com/gsulloa/argus/pull/67))
- Plain Enter applies filters in the data grid across Postgres, MySQL, MSSQL, and DynamoDB ([#65](https://github.com/gsulloa/argus/pull/65))
- Claude/Codex CLI detection hardened across user shells ([#85](https://github.com/gsulloa/argus/pull/85))

## [0.1.41] - 2026-06-17

- Maintenance and fixes

## [0.1.40] - 2026-06-17

### Added
- Tag-driven release pipeline with scripted dev/master release flow ([#114](https://github.com/gsulloa/argus/pull/114))

## [0.1.39] - 2026-06-16

- Maintenance and fixes

## [0.1.38] - 2026-06-16

- Maintenance and fixes

## [0.1.37] - 2026-06-16

- Maintenance and fixes

## [0.1.36] - 2026-06-16

### Added
- Context folder shared-project flow: one folder per project, per-table Dynamo layout, and per-connection source-path state ([#97](https://github.com/gsulloa/argus/pull/97), [#98](https://github.com/gsulloa/argus/pull/98), [#99](https://github.com/gsulloa/argus/pull/99))

## [0.1.35] - 2026-06-16

- Maintenance and fixes

## [0.1.34] - 2026-06-16

- Maintenance and fixes

## [0.1.33] - 2026-06-16

- Maintenance and fixes

## [0.1.32] - 2026-06-16

- Maintenance and fixes

## [0.1.31] - 2026-06-11

### Added
- DynamoDB model editor, AI model inspector, and sort-key filters for Single-Table Design ([#84](https://github.com/gsulloa/argus/pull/84))
- Attach executed query results to AI chat as context ([#77](https://github.com/gsulloa/argus/pull/77))
- AI chat setup readiness indicator and home onboarding checklist ([#75](https://github.com/gsulloa/argus/pull/75))

### Fixed
- SQL editor tab and AI chat panel now render correctly in MSSQL connections ([#82](https://github.com/gsulloa/argus/pull/82))

## [0.1.30] - 2026-06-10

### Added
- DynamoDB logical-name matching for CDK-style physical table names ([#86](https://github.com/gsulloa/argus/pull/86))

### Fixed
- Claude/Codex CLI detection hardened across user shells ([#85](https://github.com/gsulloa/argus/pull/85))

## [0.1.29] - 2026-06-09

### Added
- DynamoDB filter-by-model for Single-Table Design with context-folder linking ([#76](https://github.com/gsulloa/argus/pull/76))

## [0.1.28] - 2026-06-09

### Added
- Reload button and ⌘R shortcut for SQL table data grids ([#68](https://github.com/gsulloa/argus/pull/68))
- DynamoDB key input widened and click-to-sort added to the table grid ([#70](https://github.com/gsulloa/argus/pull/70))

### Fixed
- Schema tree no longer hangs on reserved-word table names ([#69](https://github.com/gsulloa/argus/pull/69))

## [0.1.27] - 2026-06-08

### Added
- Copy single cell value with ⌘C across all engines ([#95](https://github.com/gsulloa/argus/pull/95))

### Fixed
- Auto-capitalize and autocorrect disabled across all text input surfaces ([#94](https://github.com/gsulloa/argus/pull/94))
- Cmd+S saves reliably across all engines in the data edit flow ([#93](https://github.com/gsulloa/argus/pull/93))
- Client-side sorting of SQL editor query results works across all engines ([#92](https://github.com/gsulloa/argus/pull/92))

## [0.1.26] - 2026-06-08

### Fixed
- Re-applying the same filter now refetches data correctly ([#67](https://github.com/gsulloa/argus/pull/67))
- ⌘P table search ranking improved ([#66](https://github.com/gsulloa/argus/pull/66))
- Plain Enter applies filters in the data grid across Postgres, MySQL, MSSQL, and DynamoDB ([#65](https://github.com/gsulloa/argus/pull/65))

## [0.1.25] - 2026-06-04

### Fixed
- Claude/Codex CLI not found in release builds ([#61](https://github.com/gsulloa/argus/pull/61))

## [0.1.24] - 2026-06-04

### Added
- AI providers: Claude Code, Codex CLI, Anthropic API, and OpenAI API with OS keychain key storage ([#60](https://github.com/gsulloa/argus/pull/60))
- Connection context folders (cross-engine) for structured documentation and prefab queries ([#51](https://github.com/gsulloa/argus/pull/51))

## [0.1.23] - 2026-06-03

### Added
- MySQL/MariaDB and Microsoft SQL Server support reaching feature parity with Postgres ([#50](https://github.com/gsulloa/argus/pull/50))

## [0.1.22] - 2026-06-03

- Maintenance and fixes

## [0.1.21] - 2026-06-01

- Maintenance and fixes

## [0.1.20] - 2026-05-20

- Maintenance and fixes

## [0.1.19] - 2026-05-20

- Maintenance and fixes

## [0.1.18] - 2026-05-18

### Added
- Filter bar: hidden by default, flat rows, Apply All ([#47](https://github.com/gsulloa/argus/pull/47))
- Linux AppImage and Windows MSI build targets ([#42](https://github.com/gsulloa/argus/pull/42))

### Fixed
- Data grid cold-load race, header truncation, and add-row scroll ([#48](https://github.com/gsulloa/argus/pull/48))
- Release manifest always emits full `latest.json` / `download.json` ([#49](https://github.com/gsulloa/argus/pull/49))

## [0.1.17] - 2026-05-15

- Maintenance and fixes

## [0.1.16] - 2026-05-14

### Added
- Force-select rows, suppress text-drag, and live inspector edits in the data grid ([#41](https://github.com/gsulloa/argus/pull/41))

## [0.1.15] - 2026-05-14

### Added
- Resizable column widths with type-derived defaults ([#40](https://github.com/gsulloa/argus/pull/40))
- ⌘F focuses the filter bar; per-row apply and AND/OR root combinator ([#39](https://github.com/gsulloa/argus/pull/39))
- Multi-row drag-select and bulk edit in the Postgres data grid ([#38](https://github.com/gsulloa/argus/pull/38))

## [0.1.14] - 2026-05-13

### Added
- Redesigned Postgres and DynamoDB filter bars on shared primitives ([#37](https://github.com/gsulloa/argus/pull/37))

## [0.1.13] - 2026-05-13

### Fixed
- App restart after update now works correctly via the `ExitRequested` handler ([#36](https://github.com/gsulloa/argus/pull/36))

## [0.1.12] - 2026-05-13

### Fixed
- DynamoDB sidebar list refreshes after add, edit, or duplicate ([#35](https://github.com/gsulloa/argus/pull/35))

## [0.1.11] - 2026-05-13

### Added
- DynamoDB item editing via put/update/delete with full UI ([#34](https://github.com/gsulloa/argus/pull/34))
- DynamoDB scan/query/count with a data view tab ([#33](https://github.com/gsulloa/argus/pull/33))

## [0.1.10] - 2026-05-12

### Added
- Redrawn Postgres elephant and DynamoDB cylinder icons for better sidebar legibility ([#32](https://github.com/gsulloa/argus/pull/32))

## [0.1.9] - 2026-05-12

### Added
- Auto-updater install and relaunch moved to Rust with an in-app logs viewer ([#31](https://github.com/gsulloa/argus/pull/31))

## [0.1.8] - 2026-05-12

### Added
- DynamoDB connection support: profile/access-key auth, STS round-trip, and table browser ([#29](https://github.com/gsulloa/argus/pull/29), [#30](https://github.com/gsulloa/argus/pull/30))

## [0.1.7] - 2026-05-12

### Added
- "Install update & restart" action in the status bar dropdown ([#28](https://github.com/gsulloa/argus/pull/28))

## [0.1.6] - 2026-05-12

### Added
- Saved Queries: hierarchical library with inline connection switching ([#26](https://github.com/gsulloa/argus/pull/26))

## [0.1.5] - 2026-05-12

### Changed
- Inactive tabs stay mounted to eliminate refetch on tab switch ([#25](https://github.com/gsulloa/argus/pull/25))

## [0.1.4] - 2026-05-12

- Maintenance and fixes

## [0.1.3] - 2026-05-12

- Maintenance and fixes

## [0.1.2] - 2026-05-12

- Maintenance and fixes

## [0.1.1] - 2026-05-11

### Added
- Beta release pipeline: CI build, S3/CloudFront hosting, and silent auto-updater ([#22](https://github.com/gsulloa/argus/pull/22))
- Postgres filter bar with type-aware parameter binding ([#21](https://github.com/gsulloa/argus/pull/21))
- SQL editor: format button, live timer, export, and keyboard shortcut fixes ([#20](https://github.com/gsulloa/argus/pull/20))
- Data/Structure/Raw subtabs for table tabs ([#19](https://github.com/gsulloa/argus/pull/19))
- Connection groups with drag-and-drop sidebar organization ([#18](https://github.com/gsulloa/argus/pull/18))
- Query history: every SQL run persisted with a History tab ([#14](https://github.com/gsulloa/argus/pull/14))
- ⌘P table quick-switcher: jump across all active connections ([#13](https://github.com/gsulloa/argus/pull/13))
- Inline cell editing, row insert/delete, and transactional commit for Postgres ([#9](https://github.com/gsulloa/argus/pull/9))
- SQL editor end-to-end ([#10](https://github.com/gsulloa/argus/pull/10))
- Postgres schema browser ([#6](https://github.com/gsulloa/argus/pull/6))
- Bootstrap Tauri 2 desktop shell ([#2](https://github.com/gsulloa/argus/pull/2))
