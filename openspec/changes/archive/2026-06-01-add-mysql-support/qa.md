# Manual QA Checklist — add-mysql-support

> **Status**: Pending — cannot be performed without a running MySQL server in the development environment.
> Run this checklist against a local or staging MySQL 5.7+ / MariaDB 10.5+ instance before merging to master.

## Connection Management

- [ ] Open new MySQL connection (form view + URL view)
- [ ] Test connection — success path returns server version and latency
- [ ] Test connection — wrong password returns authentication error (SQLSTATE 28000)
- [ ] Test connection — unreachable host returns connection error (no SQLSTATE code)
- [ ] Save connection (without connecting)
- [ ] Save & Connect — opens the schema tree
- [ ] Connect from an existing saved connection
- [ ] Disconnect a single connection
- [ ] Disconnect-all confirmation dialog appears and clears all active connections

## Schema Browser

- [ ] Browse schema tree: databases listed with correct system/non-system marker
- [ ] Expand a database: tables, views, routines, triggers, events sections appear
- [ ] Expand a table to view indexes, triggers, foreign keys
- [ ] Per-kind failure badge appears when a sub-query fails (e.g. permission denied on events)
- [ ] Retry on `70100` (timeout) — click retry re-runs only the failed section

## Data Grid

- [ ] Query a table — rows load and display
- [ ] Apply filter for every operator: =, !=, <, <=, >, >=, LIKE, NOT LIKE, Contains, StartsWith, EndsWith, In, NotIn, BETWEEN, IS NULL, IS NOT NULL
- [ ] Case-insensitive toggle on string filters works
- [ ] Order toggle (ASC / DESC) on column headers
- [ ] Pagination: LIMIT and OFFSET work, row count badge shows approximate count
- [ ] TINYINT(1) column displays as boolean (true/false), not 0/1
- [ ] BIGINT values beyond ±2^53 display as string, not truncated number
- [ ] BLOB / BINARY column shows base64 preview or truncation envelope

## Inline Editing

- [ ] Edit a row inline — dirty highlight appears on changed cell
- [ ] Apply edits — refreshed values appear without full reload
- [ ] Insert a new row — auto_increment PK fills in from LAST_INSERT_ID
- [ ] Delete a row via the grid
- [ ] Discard pending edits dialog appears and cancels correctly
- [ ] Apply error highlights the failed op index and shows error code/message
- [ ] Read-only connection prevents edits (lock icon, no apply button)
- [ ] Duplicate PK insert fails with SQLSTATE 23000 and is rolled back

## SQL Editor

- [ ] Run a single SELECT statement — results appear in grid
- [ ] Run a single INSERT/UPDATE/DELETE — affected row count shown
- [ ] Run multi-statement SQL (SELECT; SELECT;) — both results shown
- [ ] Error in one statement stops execution, shows error position underline
- [ ] CREATE PROCEDURE in multi-statement batch rejected with DELIMITER error message
- [ ] Error position underline highlights the correct token in the editor
- [ ] Autocomplete suggests backtick-wrapped column names from columns cache

## Structure Subtab

- [ ] Open Structure subtab — Columns, Indexes, Foreign Keys, Triggers sections render
- [ ] Open Raw subtab — shows verbatim CREATE TABLE DDL string
- [ ] Partial-failure inline retry for a section that timed out

## General

- [ ] Activity log entry created for each command (connect, query, edit, run SQL)
- [ ] Query history persists across app restarts
- [ ] App does not crash on rapid connect/disconnect cycles
- [ ] Large result sets (>1000 rows) show truncation envelope correctly
