## Context

The landing (`argusdb.app`) is a single-page Vite + React app
(`packages/infra/lib/LandingStack/app/`) built by `pnpm run landing:build` and
deployed to S3 behind CloudFront (`packages/infra/lib/LandingStack/index.ts`).
Today it is one `App.tsx` (~808 lines) with no router; navigation is purely
in-page anchors (`#sources`, `#download`, …). The CloudFront distribution maps
`403` and `404` to `/index.html` with status `200` — a standard SPA rewrite. The
`landing-page` spec mandates: core content renders without network access, no
client-side tracking / cookies / analytics, and full conformance to `DESIGN.md`.

We need `/privacy` and `/terms` pages. The content type — long-form legal prose —
is new to a marketing-oriented landing.

## Goals / Non-Goals

**Goals:**
- Serve `/privacy` and `/terms` from the existing SPA with zero infrastructure
  change.
- A reusable prose-page layout that conforms to `DESIGN.md`.
- Truthful disclosure of website logging + AI-provider data flow + local storage.
- Preserve the no-cookie / no-tracking / no-analytics posture.

**Non-Goals:**
- Adding a full client-side router library (react-router) or nested routing.
- Adding a cookie-consent banner (there are no cookies).
- Authoring legally binding final text — the wording ships as a first draft
  flagged for light legal review.
- Multi-language / i18n of the legal text.
- Any change to the release-manifest / download flow.

## Decisions

### Decision: Client-side path switch, not static HTML pages
Render legal content inside the SPA by branching on
`window.location.pathname` in `App.tsx`, rather than emitting separate
`privacy.html` / `terms.html` static files.

**Why:** The CloudFront `404 → /index.html` rewrite already routes any
non-asset path to the SPA, so `/privacy` and `/terms` work with no infra change.
Reusing the SPA also reuses the loaded fonts, footer, and `styles.css` tokens.

**Alternatives considered:**
- *Static multi-page build (Vite multi-entry) or `public/privacy.html`*: S3 would
  serve real objects, but a clean `/privacy` (no `.html`) would hit the
  `404 → /index.html` rewrite and serve the SPA instead of the file — forcing
  ugly `.html` URLs or a new CloudFront Function to rewrite. Rejected: fights the
  existing rewrite and duplicates `<head>` / fonts / base styles.

### Decision: Minimal hand-rolled route switch, no router dependency
A small pure function maps `pathname` → view: `/privacy` → `<Privacy/>`,
`/terms` → `<Terms/>`, everything else → the existing landing. Footer/nav links
are plain `<a href="/privacy">` full-document navigations (no SPA history API
needed given only three static views).

**Why:** Three static, non-interactive views do not justify a router dependency
or history/popstate wiring. Keeps the bundle and mental model small.

**Alternatives considered:**
- *react-router*: over-engineered for three static pages; adds a dependency and
  bundle weight for no interaction benefit.

### Decision: Shared `LegalPage` prose layout component
Introduce one `LegalPage` layout (constrained measure ~65ch, heading hierarchy,
comfortable line-height, hairline top/bottom rules) plus per-document content
components (`Privacy`, `Terms`). The layout reuses the existing nav brand and
footer.

**Why:** The two documents share structure; a shared layout keeps DESIGN.md
conformance in one place and gives a reusable prose pattern for future doc-style
pages (e.g. changelog/docs).

**Alternatives considered:**
- *Inline JSX per page*: duplicates layout and risks design drift between the two
  pages.

### Decision: Content authored as structured components, flagged for legal review
The Privacy / Terms bodies are written as a first-draft that accurately reflects
Argus behavior (CloudFront IP+UA logs; AI-provider transmission via the ✨ chat;
keychain + context-folder local storage). A visible "draft — pending review"
posture is acceptable internally; final publish requires light legal review.

## Risks / Trade-offs

- **Inaccurate/incomplete legal text ships** → Ground the draft in the actual
  data flows documented in `CLAUDE.md` / product specs; flag for light legal
  review before public launch.
- **Legal text enters the JS bundle (vs a static file)** → Negligible: a few KB
  of text; the home already loads the same bundle. Accept.
- **`window.location.pathname` read at module scope breaks under SSR/StrictMode
  double-render** → The app is client-only (Vite SPA, no SSR); read inside the
  component render, tolerant of StrictMode. Low risk.
- **Design drift — prose layout doesn't match DESIGN.md** → Route the prose
  styles through the existing token set in `styles.css`; validate against
  `DESIGN.md` and `design/preview.html` during review.
- **Someone later adds an analytics snippet to a legal page** → The spec's
  no-tracking scenario guards this; call it out in review.

## Migration Plan

1. Add the prose styles and `LegalPage` layout + `Privacy`/`Terms` content.
2. Add the `pathname` route switch and footer links in `App.tsx`.
3. `pnpm run landing:build`; verify `/privacy` and `/terms` render locally and
   that the home is unaffected.
4. Deploy via the normal `LandingStack` path (CDK build + `BucketDeployment`
   invalidation of `/*`). No CloudFront config change.
5. Rollback: revert the app changes and redeploy; no infra state to unwind.

## Open Questions

- Contact address for privacy inquiries — dedicated alias (e.g.
  `privacy@…`) or an existing address?
- Is Argus distributed under an open-source license? If so, `/terms` can lean on
  that license for the warranty/liability disclaimer rather than a bespoke EULA.
- Retention period for CloudFront access logs — state a concrete window or a
  general posture in the policy?
