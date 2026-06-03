# Billing service — overview

This service owns user identity, order intake, and invoicing for the
storefront. It exposes a REST API at `/api/billing/*` consumed by the
storefront frontend and the back-office tools.

The interesting tables live in two Postgres schemas:

- `public.*` — user identity, sessions, audit log.
- `billing.*` — orders, invoices, payment attempts.

Soft-delete is the rule, not the exception: most "delete" actions update a
`deleted_at` column rather than removing the row. Queries that ignore this
will return ghost rows.
