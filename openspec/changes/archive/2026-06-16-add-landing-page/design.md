## Context

`LandingStack` (commit `d4ef976`) already provisions the hosting for a Vite +
React app: a private S3 bucket fronted by CloudFront with OAC, the apex + `www`
DNS records, SPA error-response fallbacks, and a synth-time `landing:build` step
that deploys `app/dist`. Only a placeholder page existed. Separately,
`ReleasesStack` hosts the release artifacts and the `download.json` manifest at
`releases.argusdb.app`, with no-cache behaviors on the manifests but no CORS.

This change fills in the actual landing page and makes the manifest fetchable
cross-origin. The visual contract is fixed by `DESIGN.md` (Watchful Precision —
dark-first, Geist, single violet accent, hairlines, the Scan flourish).

## Goals / Non-Goals

**Goals:**
- A single, fast, self-contained landing page whose primary action is downloading
  the correct macOS installer.
- Download links sourced from the real release manifest, staying current without
  a landing redeploy.
- Strict conformance to `DESIGN.md`; no generic-AI-slop aesthetics.
- Robustness: the page is never broken or empty, even offline or if the manifest
  endpoint is unavailable.

**Non-Goals:**
- No Linux/Windows installers on the page (manifest is macOS-only today; the
  rendering is driven by whatever architectures the manifest contains).
- No backend, analytics, forms, or auth.
- No changes to the Tauri app, the release pipeline, or the `LandingStack`
  infrastructure topology (only the page content it deploys).
- No build-time coupling of the landing build to the live manifest endpoint.

## Decisions

### Single-component React SPA, no UI/animation libraries
The page is implemented in `app/src/App.tsx` with a hand-written
`app/src/styles.css` of design tokens, plus the Geist fonts loaded in
`index.html`. No CSS framework, component kit, or motion library is added.
*Rationale:* the design is bespoke and token-driven; pulling in Tailwind/MUI/etc.
would fight `DESIGN.md` and bloat a tiny static page. The infra package already
has `react`, `react-dom`, `vite`, and `@vitejs/plugin-react`.
*Alternative considered:* a static-HTML page — rejected because the existing
`LandingStack` build pipeline is React/Vite and the platform-aware CTA benefits
from a small amount of client logic.

### Runtime manifest fetch with an embedded fallback snapshot
The component initializes its manifest state from an embedded constant (the
current `download.json` snapshot) and, on mount, fetches the live manifest with
`cache: "no-cache"`; on a valid response it swaps in the fetched data, otherwise
it keeps the embedded snapshot.
*Rationale:* freshness without redeploys, but never a broken CTA. Progressive
enhancement: the fetch is purely additive.
*Alternative considered:* baking the manifest at build time via a Vite `define` —
rejected because it would couple every landing build to the availability of the
releases endpoint and still go stale between deploys.

### Best-effort architecture detection, both options always shown
Apple Silicon vs Intel is inferred from the WebGL unmasked renderer string
(`"apple"` → arm, `"intel"` → x86_64), defaulting to Apple Silicon when unknown.
The hero CTA points at the detected build; the dedicated download section always
lists both architectures with the manifest's filename and size.
*Rationale:* the web platform has no reliable CPU-arch API; the cost of a wrong
guess is bounded because the other build is one click away. Apple Silicon is the
safer default for new Macs.
*Alternative considered:* `navigator.userAgentData.getHighEntropyValues` —
unreliable/absent on Safari, so used as neither sole nor primary signal.

### CORS via a CloudFront ResponseHeadersPolicy scoped to the landing origins
A single `ResponseHeadersPolicy` with a CORS config (`GET`/`HEAD`, no
credentials, origins `argusdb.app` + `www.argusdb.app`) is attached to the
`download.json` and `latest.json` behaviors in `ReleasesStack`.
*Rationale:* the runtime fetch is cross-origin (apex → `releases` subdomain) and
fails without `Access-Control-Allow-Origin`. Scoping to the landing origins keeps
it tight; the embedded fallback means the page survives even before this deploys.
*Alternative considered:* allow `*` — rejected as needlessly permissive for a
manifest only the landing needs to read cross-origin.

## Risks / Trade-offs

- **Architecture mis-detection serves the wrong-arch primary CTA** → both builds
  are always listed in the download section, and the size/filename make the arch
  explicit, so a wrong guess is a one-click correction, not a dead end.
- **Manifest endpoint down or CORS not yet deployed** → embedded fallback keeps
  the page fully functional; only auto-freshness is lost until the fetch works.
- **Embedded snapshot drifts from reality between releases** → the runtime fetch
  is the primary source when reachable; the snapshot only needs updating if it is
  ever the long-term source (e.g., CORS removed). Acceptable for a fallback.
- **CORS policy applied to the wrong behaviors** → it is attached only to the two
  manifest behaviors, leaving binary caching and OAC untouched; verifiable in
  `cdk synth`.

## Migration Plan

1. Land the landing page + `ReleasesStack` CORS change.
2. Deploy `ReleasesStack` so the manifest serves CORS headers.
3. Deploy `LandingStack` (runs `landing:build`, publishes `app/dist`, invalidates
   CloudFront).
4. Verify `https://argusdb.app` renders and the download CTA reflects the live
   manifest version with working installer links.

Rollback: redeploy the previous `LandingStack` asset (placeholder) and/or revert
the `ResponseHeadersPolicy`; the page's embedded fallback means reverting CORS
does not break downloads.

## Open Questions

- Should the page advertise Linux/Windows builds once those installers appear in
  the manifest? The rendering already iterates the manifest, so it is mostly a
  copy/section decision rather than a structural one.
