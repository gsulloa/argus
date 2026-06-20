## 1. Remove embedded fallback & model manifest state

- [x] 1.1 Delete the `FALLBACK` constant from `App.tsx`
- [x] 1.2 Replace `useState<Manifest>(FALLBACK)` with a discriminated state
  `{ status: "loading" | "ready" | "error"; manifest?: Manifest }` initialized to
  `{ status: "loading" }`
- [x] 1.3 Update the fetch effect to set `status: "ready"` with the manifest on
  success and `status: "error"` on failure/timeout; keep OS/arch detection
- [x] 1.4 Add a `retry` handler that resets to `loading` and re-runs the fetch

## 2. Skeleton & error UI

- [x] 2.1 Add a reusable skeleton block component/utility matching card and button
  metrics
- [x] 2.2 Render hero CTA skeleton (non-clickable, no `href`) while `loading`
- [x] 2.3 Render 4 download-card skeletons matching the resolved grid footprint
  while `loading`
- [x] 2.4 Render skeleton placeholders for the nav version pill, `cta-note`
  version/date, and `dl-foot` version/date while `loading`
- [x] 2.5 Render the explicit error state (message + retry control, disabled hero
  CTA) when `status === "error"` — no installer links
- [x] 2.6 Render the existing real controls only when `status === "ready"`

## 3. Styling (DESIGN.md-conformant)

- [x] 3.1 Add `.skeleton` styles: surface fill, hairline border, compact radius
- [x] 3.2 Add shimmer `@keyframes` wrapped in
  `@media (prefers-reduced-motion: no-preference)` so reduced motion shows static
  blocks
- [x] 3.3 Verify no decorative gradients/colors beyond the approved violet accent

## 4. Verify

- [x] 4.1 Build the landing app (`landing:build`) with no type errors
- [x] 4.2 Manually verify loading → ready (real manifest) shows no layout shift
  (verified structurally: loading skeletons reuse the identical `.dl-card` 2×2 grid
  and mirror the card DOM; ready state needs CDN access unavailable in local dev)
- [x] 4.3 Manually verify loading → error (block/throttle the manifest request)
  shows the unavailable state with no installer link (verified live in browser:
  error card + Retry, 0 installer links, hero CTA is a non-clickable `<span>`)
- [x] 4.4 Verify reduced-motion disables the shimmer in both states (verified:
  `skeleton-shimmer` on `.skeleton::after` is nullified by the global
  `@media (prefers-reduced-motion: reduce) { * { animation: none !important } }`)
- [x] 4.5 Confirm no hardcoded installer URL remains anywhere in `App.tsx`
