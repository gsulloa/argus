## Why

The public landing at `argusdb.app` collects personal data through CloudFront
standard access logs (visitor IP + user-agent), and the Argus product itself
transmits user data to third-party AI providers (Anthropic / OpenAI) when the AI
chat is used. Under GDPR/CCPA a visitor-facing privacy notice is required once
personal data is processed — even with no cookies or client-side tracking. The
landing today has no `/privacy` or `/terms` route, leaving this exposure
undocumented. A short, honest Privacy Policy (and an "as-is" Terms/EULA) closes
the gap without adding any tracking.

## What Changes

- Add a `/privacy` route to the landing SPA that renders a Privacy Policy
  covering: CloudFront server-side access logs (IP + user-agent), data sent to
  AI providers via the in-app AI chat, local-only credential/context storage
  (OS keychain, context folders), retention, legal basis, and a contact address.
- Add a `/terms` route rendering an "as-is" Terms of Service / EULA with a
  disclaimer of warranty and liability for the freely-distributed desktop app.
- Introduce a reusable **long-form prose page** layout (constrained measure,
  heading hierarchy, comfortable line-height) that conforms to `DESIGN.md` —
  a content type the marketing-oriented landing does not currently cover.
- Route selection is driven by `window.location.pathname`; the existing
  CloudFront `404 → /index.html` rewrite already serves these paths to the SPA,
  so no infrastructure change is required.
- Add `Privacy` and `Terms` links to the landing footer.
- No new cookies, analytics, or client-side tracking are introduced — the page
  remains free of runtime analytics; the policy only *documents* existing
  server-side logging.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `landing-page`: Adds a requirement for visitor-facing legal routes
  (`/privacy`, `/terms`) served by the SPA and a design-system-conformant
  long-form prose layout, without altering the page's no-tracking / no-cookie
  posture.

## Impact

- **Code**: `packages/infra/lib/LandingStack/app/src/App.tsx` (path-based route
  switch, footer links), new legal content components under
  `src/legal/`, prose styles in `src/styles.css`.
- **Infra**: None. Relies on the existing CloudFront `403/404 → /index.html`
  error responses (`packages/infra/lib/LandingStack/index.ts`).
- **Spec**: `openspec/specs/landing-page/spec.md` gains a legal-routes
  requirement.
- **Non-code**: The actual legal text must reflect what Argus does with data;
  final wording warrants a light legal review before publishing.
