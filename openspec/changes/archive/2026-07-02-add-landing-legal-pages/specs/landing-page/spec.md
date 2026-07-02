## ADDED Requirements

### Requirement: Visitor-facing legal routes served by the SPA

The landing app SHALL serve a Privacy Policy at the `/privacy` path and a Terms
of Service (EULA) at the `/terms` path. Route selection MUST be derived from
`window.location.pathname` within the existing single-page app; these routes MUST
rely on the distribution's existing `403/404 → /index.html` error responses and
MUST NOT require any new S3 object, CloudFront behavior, or infrastructure
change. Each legal page MUST render its full text without depending on any
runtime network request (no manifest fetch, no third-party script). The landing
footer MUST present links to `/privacy` and `/terms`, and each legal page MUST
offer a link back to the landing home (`/`).

#### Scenario: Privacy Policy route renders

- **WHEN** a visitor requests `https://argusdb.app/privacy`
- **THEN** CloudFront serves `/index.html`, the SPA detects the `/privacy` path,
  and the Privacy Policy content renders in full without any network request

#### Scenario: Terms route renders

- **WHEN** a visitor requests `https://argusdb.app/terms`
- **THEN** the SPA detects the `/terms` path and renders the Terms of Service
  (EULA) content in full

#### Scenario: Footer links reach the legal pages

- **WHEN** a visitor views the landing home and activates the footer `Privacy`
  or `Terms` link
- **THEN** the corresponding legal page is shown, and a link back to the home
  page is available from that page

#### Scenario: Unknown paths still fall back to the landing home

- **WHEN** a visitor requests a path that is neither `/privacy` nor `/terms` and
  is not a real asset
- **THEN** the SPA renders the landing home rather than an error or a blank page

### Requirement: Privacy Policy discloses all visitor and product data processing

The Privacy Policy at `/privacy` SHALL truthfully disclose every category of
personal data processed by the landing and the Argus product, specifically:
CloudFront standard access logs capturing visitor IP address and user-agent for
the website; data transmitted to third-party AI providers (Anthropic, OpenAI)
when the in-app AI chat is used; and the local-only storage of connection
credentials (OS keychain) and context folders on the user's device. The policy
MUST state the purpose and legal basis for the website logging, a retention
posture, and a contact address for privacy inquiries. The policy MUST NOT claim
that no data is collected.

#### Scenario: Website logging is disclosed

- **WHEN** a visitor reads the Privacy Policy
- **THEN** it states that CloudFront access logs capture IP address and
  user-agent, the purpose (operation/security), and a retention posture

#### Scenario: AI provider data flow is disclosed

- **WHEN** a visitor reads the Privacy Policy
- **THEN** it states that using the in-app AI chat transmits query content and
  context to the selected third-party AI provider (Anthropic or OpenAI)

#### Scenario: Local-only storage is distinguished from transmitted data

- **WHEN** a visitor reads the Privacy Policy
- **THEN** it states that connection credentials are stored in the OS keychain
  and context folders remain on the user's device, distinct from data sent to
  external services

### Requirement: Legal pages use a design-system-conformant prose layout

The legal pages MUST render long-form prose using a layout that conforms to
`DESIGN.md`: Geist / Geist Mono typography, a constrained reading measure,
clear heading hierarchy, comfortable line-height, hairline borders, the compact
radius scale, the single violet accent used sparingly, and no decorative
gradients beyond the brand mark. The pages MUST honor
`prefers-reduced-motion: reduce`. The legal pages MUST NOT introduce any cookie,
analytics script, or client-side tracking; the landing bundle MUST remain free
of runtime analytics.

#### Scenario: Prose layout conforms to the design system

- **WHEN** a legal page is viewed
- **THEN** its typography, color, borders, radii, and spacing conform to
  `DESIGN.md` and no decorative gradient beyond the brand mark is present

#### Scenario: No tracking is added by the legal pages

- **WHEN** a legal page is built and loaded
- **THEN** no GA4 / gtag / third-party analytics script and no tracking cookie
  is present
