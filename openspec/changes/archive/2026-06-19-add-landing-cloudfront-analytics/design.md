## Context

The landing site (`LandingStack`, served at `argusdb.app`) and the release
artifacts (`ReleasesStack`, served at `releases.argusdb.app`) are both private S3
buckets fronted by CloudFront with Origin Access Control. Neither distribution
currently emits access logs. A GA4-based client tracker was prototyped and then
reverted, so today there is **no** measurement of visits or downloads.

We want two numbers — *visits* and *real downloads* — at the lowest possible cost
and without reintroducing a client-side tracker or cookie consent. CloudFront can
log every viewer request to S3, and Argus already ships an Athena connection, so
the logs can be queried with the product itself. The constraint set: minimal
recurring cost, no application/runtime changes, privacy-friendly (no cookies, no
third party), and consistent with the existing CDK conventions in
`packages/infra` (SSM-published cross-stack handles like `DnsStack`, `RETAIN`
removal on stateful buckets, snapshot tests under `test/`).

## Goals / Non-Goals

**Goals:**
- Capture every landing page request and every installer download as durable S3
  access logs.
- Provide an Athena/Glue query surface that returns "visits per day" and
  "downloads by platform & version" with no manual setup beyond running a query.
- Keep recurring cost in the cents-per-month range and cap per-query Athena scan.
- Stay entirely in infrastructure + query tooling — the landing bundle and Tauri
  app are untouched.

**Non-Goals:**
- No client-side analytics, session tracking, funnels, scroll/engagement events,
  or per-user identity. (CloudWatch RUM / Pinpoint are explicitly out of scope.)
- No real-time dashboard or alerting; daily/manual querying is sufficient for v1.
- No reintroduction of GA4 or any cookie.
- No CloudWatch Logs ingestion of the access logs (would add per-GB cost for no
  benefit here).

## Decisions

### Decision 1: CloudFront **standard logging (legacy, to S3)** over standard logging v2

Use the distribution's built-in standard logging (`enableLogging` + `logBucket` +
`logFilePrefix` in CDK) which delivers gzipped tab-separated logs to S3 at no
CloudFront charge.

- *Alternative — Standard logging v2 (Hive-partitioned S3 / Parquet via vended
  log deliveries):* better partitioning for Athena, but CDK only exposes it via
  L1 delivery-source/destination constructs (more moving parts) and the benefit
  (partition pruning) is irrelevant at our log volume. Rejected for v1; revisit
  if traffic grows enough that full-scan query cost matters.
- *Alternative — Real-time logs to Kinesis:* per-line Kinesis cost, overkill.

### Decision 2: One **shared, ACL-enabled** log bucket with per-distribution prefixes

A single S3 bucket holds both log streams under `landing/` and `releases/`
prefixes. Legacy CloudFront log delivery writes via the `awslogsdelivery`
canonical-user ACL grant, so the bucket **MUST** have ACLs enabled
(`ObjectOwnership.BUCKET_OWNER_PREFERRED`) — a bucket with ACLs disabled (the S3
default) silently receives no logs. The bucket blocks public access, enforces
SSL, uses S3-managed encryption, a `RETAIN` removal policy, and a **lifecycle
rule expiring objects after a fixed retention window** (default 90 days) to bound
storage cost.

- *Alternative — one bucket per stack:* duplicated config, two lifecycle rules,
  no benefit. Rejected.

### Decision 3: A dedicated **AnalyticsStack** owns the log bucket + query surface; Landing/Releases import it via SSM

The log bucket, Glue database, external tables, Athena workgroup, results
location, and named queries live in a new `${PROJECT_NAME}AnalyticsStack` under
`lib/AnalyticsStack/`. It publishes the log bucket name to SSM (mirroring the
`DnsStack.getHostedZone`/`getCertificate` pattern). `LandingStack` and
`ReleasesStack` import the bucket by name and set it as their `logBucket`. Stack
dependencies (`landing/releases → analytics`) guarantee the bucket exists before
logging is enabled.

- *Alternative — put the bucket in LandingStack and have Releases import it:*
  asymmetric ownership, awkward when one stack is torn down. Rejected.

### Decision 4: **Non-partitioned** Glue external tables defined in IaC

Two Glue `CfnTable`s (e.g. `landing_logs`, `releases_logs`) describe the
CloudFront standard-log schema (tab-delimited, skip 2 header lines) pointing at
the `landing/` and `releases/` prefixes. Legacy logs land flat (date is in the
filename, not the path), so date-path partition projection is not available;
given MB-scale data, a full scan per query costs a fraction of a cent. Tables are
defined in IaC so they are queryable immediately — no manual `CREATE TABLE`.

- *Alternative — partition projection:* needs date in the S3 key, which legacy
  logging does not provide. Would require an S3-trigger reorganizer. Rejected as
  premature.

### Decision 5: Dedicated Athena **workgroup** with results location and a per-query scan cap

Create an Athena workgroup with an enforced output location (a results prefix in
the log bucket or a small dedicated bucket) and `BytesScannedCutoffPerQuery` set
as a guardrail so a runaway query can never produce a surprising bill. Ship the
two reports as `CfnNamedQuery` entries so they are discoverable and runnable from
Argus's Athena connection.

### Decision 6: Counting semantics

- **Visits** = requests to the landing distribution for HTML documents
  (`index.html` / root) with status `200`, grouped by day; an approximate unique
  count uses distinct client IP. (No cookies → IP is the only available
  identity, reported as an approximation.)
- **Downloads** = requests to the releases distribution whose URI ends in an
  installer extension (`.dmg`, `.msi`, `.AppImage`) with a success/partial status
  (`200`/`206`), grouped by installer key and manifest version parsed from the
  filename. Each viewer download is logged regardless of edge cache state, so
  counts reflect real file fetches, not clicks.

## Risks / Trade-offs

- **ACLs disabled → silent no-op.** If the log bucket ships with ACLs disabled,
  CloudFront delivers nothing and the failure is silent. → Set
  `ObjectOwnership.BUCKET_OWNER_PREFERRED` and assert it in a snapshot test;
  verify post-deploy that objects appear under both prefixes.
- **Region coupling for queries.** Glue/Athena are regional; Argus must connect
  in the same region the analytics resources are deployed. → Deploy in the
  account's standard deploy region and document it in the spec/README.
- **Log delivery latency.** Standard logs can arrive minutes-to-~24h late. →
  Acceptable for daily metrics; documented as a known limitation.
- **Bot / crawler noise inflates visit counts.** → Reporting queries filter by
  status and (for downloads) installer extension; visit query can additionally
  exclude obvious bot user-agents. Documented, not over-engineered.
- **Full-scan cost grows with traffic.** Non-partitioned scan is fine at MB
  scale; at GB+ it becomes the cost driver. → Lifecycle expiry caps the window;
  the per-query cap bounds blast radius; partition projection (Decision 4
  alternative) is the documented upgrade path.
- **Privacy / PII.** Access logs contain client IP. → No cookies and no
  cross-request identity are introduced; retention is bounded by lifecycle. IP
  truncation is noted as an open question rather than built in v1.

## Migration Plan

1. Deploy `AnalyticsStack` first (creates the log bucket + Glue/Athena surface,
   publishes the bucket name to SSM).
2. Redeploy `LandingStack` and `ReleasesStack` with logging enabled (they import
   the bucket; stack dependency enforces ordering).
3. Verify objects appear under `landing/` and `releases/` within ~1 hour, then
   run the two named queries from Argus's Athena connection.
4. **Rollback:** flip logging off on the two distributions and redeploy; the
   `AnalyticsStack` and its retained log bucket can be left in place or destroyed
   independently. No application rollback is needed since nothing in the app
   changed.

## Open Questions

- Which AWS region hosts Glue/Athena (i.e. which region will the Argus Athena
  connection point at)? Default: the account's standard deploy region.
- Log retention window — confirm 90 days (vs 30 / 180) for the lifecycle rule.
- Do we want client-IP truncation/anonymization in v1 for privacy posture, or
  defer it given bounded retention and no cookies?
- Results location: a `results/` prefix inside the shared log bucket vs a small
  dedicated results bucket — any objection to colocating under one bucket?
