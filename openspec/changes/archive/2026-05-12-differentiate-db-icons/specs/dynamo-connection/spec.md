## ADDED Requirements

### Requirement: DynamoDB icon visual identity

The `DynamoIcon` component exported from `src/modules/dynamo/index.ts` SHALL render a horizontally-banded geometric silhouette in the shape of a stacked database cylinder (top ellipse plus at least two stacked layers connected by side walls), designed so that at 14px (the sidebar connection-row size) it is unambiguously distinguishable from the `PostgresIcon` silhouette without color cues.

The icon MUST:
- Use a 24×24 viewBox.
- Use hairline strokes only (`stroke-width` 1.5, `stroke="currentColor"`, `fill="none"` on all primary shapes).
- Inherit color via `currentColor`. The component MUST NOT hardcode any color value, gradient, brand color (including AWS orange), or duotone fill.
- Avoid trademarked AWS iconography. The mark MUST be a generic database silhouette, not the AWS DynamoDB product mark.
- Expose the same component contract as today: a named export `DynamoIcon` accepting `{ size?: number; className?: string }` with `size` defaulting to 16.
- Carry `role="img"` and `aria-label="DynamoDB"` on the root `<svg>`.

The silhouette's primary shape category SHALL be "stacked cylinder with horizontal banding" — it MUST NOT be an organic blob, an elephant-like curve, an animal silhouette, or any other primarily-organic form that could collide with the Postgres icon.

#### Scenario: Sidebar shows the icon at 14px next to a Postgres row

- **WHEN** the sidebar's Connections section renders a DynamoDB row immediately above or below a Postgres row at the default 14px icon size
- **THEN** the DynamoDB row's icon presents the stacked-cylinder silhouette, the Postgres row's icon presents the elephant head-and-trunk silhouette, and a user can identify each row's kind by icon alone (no name, no badge) at normal reading distance

#### Scenario: Icon inherits muted text color

- **WHEN** `DynamoIcon` is rendered inside the sidebar where the parent applies `color: var(--text-muted)`
- **THEN** every stroked shape in the SVG renders in the muted text color, with no hardcoded color string and no `fill` other than `none` anywhere in the component

#### Scenario: Icon component contract is preserved

- **WHEN** a caller renders `<DynamoIcon />`, `<DynamoIcon size={14} />`, `<DynamoIcon size={20} />`, or `<DynamoIcon className="foo" />`
- **THEN** the SVG renders at the requested square size (defaulting to 16), applies the optional className to the root `<svg>`, and exposes `role="img"` with `aria-label="DynamoDB"`
