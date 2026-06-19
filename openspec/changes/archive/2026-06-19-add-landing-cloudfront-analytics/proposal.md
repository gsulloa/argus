## Why

The GA4 instrumentation that was prototyped for the landing page has been
reverted. We still need to answer two questions — *how many people visit the
landing, and who downloads the app* — but without a third-party tracker, its
cookie-consent burden, or click-based download events that overcount. Both the
landing site and the release artifacts already run on S3 + CloudFront, which can
emit a complete access log of every request at effectively zero marginal cost.
Querying those logs with Athena (a source Argus already supports — we read our
own analytics with our own product) gives accurate, privacy-friendly traffic and
real-download metrics for cents per month.

## What Changes

- Provision a single shared, private S3 **log bucket** (ACL-enabled so CloudFront
  can deliver legacy standard logs, lifecycle-expired to cap storage cost,
  `RETAIN` removal policy).
- Enable CloudFront **standard access logging** on the `LandingStack`
  distribution (prefix `landing/`) to capture page visits.
- Enable CloudFront **standard access logging** on the `ReleasesStack`
  distribution (prefix `releases/`) to capture real installer downloads (the
  actual file GET, not a click).
- Provision Athena query surface: a **Glue database**, two **external tables**
  over the log prefixes using the CloudFront standard-log format, and an Athena
  **workgroup** with an S3 results location and a per-query bytes-scanned cap.
- Ship two ready-to-run **saved/named queries**: "visits per day" (landing) and
  "downloads by platform & version" (releases), runnable from Argus's Athena
  connection.
- No GA4, no client-side tracking script, no cookies are (re)introduced — the
  landing app stays free of analytics JS.

## Capabilities

### New Capabilities

- `web-traffic-analytics`: CloudFront standard access logging for the landing and
  releases distributions delivered to a private, cost-capped S3 log bucket, plus
  the Athena/Glue query surface (database, external tables, workgroup, and the
  visits and downloads reporting queries) used to measure visits and real
  downloads.

### Modified Capabilities

- `landing-page`: the `LandingStack` distribution gains a requirement to emit
  standard access logs to the shared log bucket under the `landing/` prefix.
- `release-artifact-hosting`: the `ReleasesStack` distribution gains a
  requirement to emit standard access logs to the shared log bucket under the
  `releases/` prefix.

## Impact

- **Code/IaC**: `packages/infra/lib/LandingStack/index.ts` and
  `packages/infra/lib/ReleasesStack/index.ts` (enable logging); a new analytics
  construct/stack for the shared log bucket + Glue/Athena resources;
  `packages/infra/constants.ts` (log prefixes, Glue/workgroup names);
  `packages/infra/bin/infra.ts` (wire the new stack and stack dependencies).
- **Tests**: `packages/infra/test/*` snapshot/assertion tests for the new
  logging config and analytics resources.
- **AWS resources/cost**: one S3 bucket (logs, with lifecycle expiry), one Glue
  database + two tables, one Athena workgroup + results location. Cost is
  dominated by negligible S3 storage and per-query Athena scan (≈ $5/TB over
  MB-sized logs) — realistically cents per month.
- **No application/runtime impact**: the landing bundle and the Tauri app are
  unchanged; this is infrastructure + query tooling only.
