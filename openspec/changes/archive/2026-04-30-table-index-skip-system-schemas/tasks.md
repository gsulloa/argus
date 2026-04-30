## 1. Implement filter

- [x] 1.1 Import `isSystemSchema` from `@/modules/postgres/schema/globalSchemaCache` in `src/platform/command-palette/useTableIndex.ts`.
- [x] 1.2 In `flatten()`, skip any schema where `isSystemSchema(s.name)` is true before iterating its relations.
- [x] 1.3 In the eager-load `useEffect`, skip any schema where `isSystemSchema(s.name)` is true before checking inflight / firing `listRelations`.

## 2. Verify behavior

- [x] 2.1 Open ⌘P with an active connection on a database that has many `pg_temp_*` schemas; confirm via the activity log / Tauri logs that no `postgres_list_relations` is issued for any `pg_*` or `information_schema` schema.
- [x] 2.2 Confirm user-schema relations (`public`, app schemas) still appear in the picker and are eager-loaded as before.
- [x] 2.3 Confirm the sidebar tree's "System schemas" group still lists `pg_catalog`, `information_schema`, etc. — this change must not affect it.
