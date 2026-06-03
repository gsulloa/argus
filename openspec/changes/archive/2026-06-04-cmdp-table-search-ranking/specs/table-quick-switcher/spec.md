## MODIFIED Requirements

### Requirement: Fuzzy search across schema, name, and connection

When the user types in the search input, the visible entries SHALL be filtered by case-insensitive match against `schema`, relation `name`, the combined `schema.name` form, and the connection display name. Results MUST be ordered by a deterministic tiered scoring scheme: an exact match on the relation `name` outranks a prefix match on the relation `name`, which outranks a substring match on the relation `name`, which outranks matches on `schema` (exact > prefix > substring), which outrank matches on the connection display name (exact > prefix > substring). For two-segment queries of the form `<schemaFragment>.<nameFragment>`, ranking SHALL be computed by combining the schema-segment match tier and the name-segment match tier so that entries whose `schema` matches the schema fragment AND whose `name` matches the name fragment outrank entries that only match one side. A fuzzy substring match (the previous default behaviour) SHALL still be applied as a final fallback tier so that mid-word and non-contiguous matches still surface, ranked below all structured tiers and used only as a tie-breaker within a tier.

#### Scenario: Matching by relation name

- **WHEN** entries include `public.users` and `auth.sessions` and the user types `usr`
- **THEN** `public.users` ranks at or near the top of the filtered list

#### Scenario: Matching by schema-qualified name

- **WHEN** entries include `auth.users` and `public.users` and the user types `auth.us`
- **THEN** `auth.users` is visible and ranks higher than `public.users`

#### Scenario: Matching by connection name

- **WHEN** entries from connections `supabase-prod` and `supabase-staging` are listed and the user types `staging`
- **THEN** only entries from the `supabase-staging` connection remain visible

#### Scenario: Exact name match beats longer substring match

- **WHEN** entries include `client.order` and `client.assistant_manual_pending_orders` and the user types `order`
- **THEN** `client.order` ranks above `client.assistant_manual_pending_orders`

#### Scenario: Prefix on the relation name beats substring elsewhere

- **WHEN** entries include `public.orders` and `client.assistant_manual_pending_orders` and the user types `ord`
- **THEN** `public.orders` ranks above `client.assistant_manual_pending_orders`

#### Scenario: Two-segment query prefers exact schema match

- **WHEN** entries include `auth.users`, `auth.user_sessions`, and `public.users` and the user types `auth.us`
- **THEN** `auth.users` ranks first, `auth.user_sessions` ranks above `public.users`, and `public.users` (whose schema is not `auth`) ranks below both `auth.*` matches

#### Scenario: Fuzzy fallback still surfaces mid-word matches

- **WHEN** entries include `public.subscriptions` and the user types `scrip`
- **THEN** `public.subscriptions` is visible in the filtered list (matched via the fallback tier) even though no structured tier matched

