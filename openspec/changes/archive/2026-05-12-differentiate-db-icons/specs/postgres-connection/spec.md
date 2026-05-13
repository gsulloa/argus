## ADDED Requirements

### Requirement: Postgres icon visual identity

The `PostgresIcon` component exported from `src/modules/postgres/index.ts` SHALL render an organic, rounded silhouette that reads as an elephant head-and-trunk profile, designed so that at 14px (the sidebar connection-row size) it is unambiguously distinguishable from the `DynamoIcon` silhouette without color cues.

The icon MUST:
- Use a 24×24 viewBox.
- Use hairline strokes only (`stroke-width` 1.5, `stroke="currentColor"`, no `fill` other than `currentColor` on tiny detail nodes ≤1px radius such as the eye).
- Inherit color via `currentColor`. The component MUST NOT hardcode any color value, gradient, brand color, or duotone fill.
- Expose the same component contract as today: a named export `PostgresIcon` accepting `{ size?: number; className?: string }` with `size` defaulting to 16.
- Carry `role="img"` and `aria-label="Postgres"` on the root `<svg>`.

The silhouette's primary shape category SHALL be "rounded organic blob with a clearly identifiable curving trunk extending from the head mass" — it MUST NOT be a rectangle, a rounded rectangle, a cylinder, a stack of horizontal bands, a hexagon, or any other primarily-geometric form that could collide with another source-kind icon.

#### Scenario: Sidebar shows the icon at 14px next to a DynamoDB row

- **WHEN** the sidebar's Connections section renders a Postgres row immediately above or below a DynamoDB row at the default 14px icon size
- **THEN** the Postgres row's icon presents the elephant head-and-trunk silhouette, the DynamoDB row's icon presents the stacked-cylinder silhouette, and a user can identify each row's kind by icon alone (no name, no badge) at normal reading distance

#### Scenario: Icon inherits muted text color

- **WHEN** `PostgresIcon` is rendered inside the sidebar where the parent applies `color: var(--text-muted)`
- **THEN** every stroked path and any tiny filled detail node in the SVG renders in the muted text color, with no hardcoded color string anywhere in the component

#### Scenario: Icon component contract is preserved

- **WHEN** a caller renders `<PostgresIcon />`, `<PostgresIcon size={14} />`, `<PostgresIcon size={20} />`, or `<PostgresIcon className="foo" />`
- **THEN** the SVG renders at the requested square size (defaulting to 16), applies the optional className to the root `<svg>`, and exposes `role="img"` with `aria-label="Postgres"`
