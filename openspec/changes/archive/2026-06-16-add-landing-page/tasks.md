## 1. Landing page scaffold & shell

- [x] 1.1 Add Geist / Geist Mono fonts, meta/OG tags, theme-color, and an inline eye-mark favicon to `app/index.html`
- [x] 1.2 Import the stylesheet in `app/src/main.tsx`
- [x] 1.3 Create `app/src/styles.css` with the `DESIGN.md` tokens (surfaces, text, violet accent, radius, motion durations) and atmosphere layers (violet glow, dot field, grain)

## 2. Page content & sections

- [x] 2.1 Build the sticky nav (brand + eye mark, section links, version pill, download CTA)
- [x] 2.2 Build the asymmetric hero (eyebrow, headline, lede, platform-aware CTA cluster, meta note)
- [x] 2.3 Build the three-pane console mockup (titlebar, sidebar, virtualized grid with active-row stripe + status pills, inspector with PK marker)
- [x] 2.4 Build the six-source grid (Postgres, MySQL/MariaDB, SQL Server, DynamoDB, CloudWatch, Athena)
- [x] 2.5 Build the "console" callout and the features bento (data grid, SQL editor, command palette, context folders, AI providers)
- [x] 2.6 Build the footer

## 3. Download CTA & manifest integration

- [x] 3.1 Embed the current `download.json` snapshot as the initial/fallback manifest state
- [x] 3.2 Fetch the live manifest at runtime (`no-cache`) and swap in fetched values on a valid response; keep the fallback on failure
- [x] 3.3 Implement best-effort Apple Silicon vs Intel detection (WebGL renderer), defaulting to Apple Silicon
- [x] 3.4 Render the hero CTA against the detected architecture (label, arch, size) and link to the installer URL
- [x] 3.5 Render the download section with a card per architecture (filename, size, `.dmg`, recommended badge) and version + release date
- [x] 3.6 Add `prefers-reduced-motion` handling for the Scan flourish and scroll reveals

## 4. ReleasesStack CORS

- [x] 4.1 Add a `ResponseHeadersPolicy` (CORS: `GET`/`HEAD`, no credentials, origins `argusdb.app` + `www.argusdb.app`) in `lib/ReleasesStack/index.ts`
- [x] 4.2 Attach the policy to the `download.json` and `latest.json` cache behaviors, leaving OAC and no-cache behavior intact

## 5. Verification

- [x] 5.1 `pnpm run build` (tsc) passes for the infra package
- [x] 5.2 `pnpm run landing:build` produces `app/dist`
- [x] 5.3 Visually verify hero, sections, download CTA, and mobile layout in a browser; confirm download links resolve to real installer URLs
