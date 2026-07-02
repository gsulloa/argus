## 1. Prose layout & styles

- [x] 1.1 Add design-system-conformant prose styles to `src/styles.css` (constrained ~65ch measure, heading hierarchy, comfortable line-height, hairline rules, compact radii, violet accent used sparingly, no gradients)
- [x] 1.2 Ensure prose styles honor `prefers-reduced-motion: reduce`
- [x] 1.3 Add a reusable `LegalPage` layout component (reuses the nav brand + footer, adds a "back to home" link)

## 2. Legal content

- [x] 2.1 Author the Privacy Policy content component: CloudFront access logs (IP + user-agent), purpose/legal basis, retention posture, contact address
- [x] 2.2 Extend the Privacy Policy with the AI-provider data flow (query/context sent to Anthropic/OpenAI via the in-app AI chat)
- [x] 2.3 Extend the Privacy Policy with local-only storage (OS keychain credentials, on-device context folders) distinguished from transmitted data
- [x] 2.4 Author the Terms of Service / EULA content component (as-is disclaimer of warranty and liability; reference OSS license if applicable)
- [x] 2.5 Add a visible "draft — pending legal review" posture until wording is reviewed

## 3. Routing & footer

- [x] 3.1 Add a pure `pathname → view` switch in `App.tsx` (`/privacy` → Privacy, `/terms` → Terms, else the existing landing)
- [x] 3.2 Add `Privacy` and `Terms` links to the landing footer (plain `<a href>` navigations)
- [x] 3.3 Verify unknown paths fall back to the landing home (no error/blank state)

## 4. Verification

- [x] 4.1 `pnpm run landing:build` succeeds
- [x] 4.2 `/privacy` and `/terms` render full content with the manifest fetch blocked (no network dependency)
- [x] 4.3 Confirm no cookie / GA4 / gtag / third-party analytics script is present in the built bundle
- [x] 4.4 Confirm the landing home is visually unchanged and design conforms to `DESIGN.md` (check against `design/preview.html`)
- [x] 4.5 No CloudFront/CDK change needed — deploy relies on existing `403/404 → /index.html` rewrite
