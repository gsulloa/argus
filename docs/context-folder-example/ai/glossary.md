# Glossary

- **Customer** — a `users` row with at least one `orders` row.
- **Stuck order** — an `orders` row with `status = 'pending'` and
  `created_at` older than 24 hours.
- **Tombstone** — a soft-deleted row (`deleted_at IS NOT NULL`). Excluded
  from most reporting by convention.
- **Inventory hold** — a transient lock on a SKU during order intake; see
  `inventory_holds` table.
