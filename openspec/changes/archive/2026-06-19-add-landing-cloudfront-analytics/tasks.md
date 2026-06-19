## 1. Constants & wiring

- [x] 1.1 Add analytics constants to `packages/infra/constants.ts` (log bucket SSM param name, `landing/` and `releases/` log prefixes, Glue database name, Athena workgroup name, log retention days)
- [x] 1.2 Register `AnalyticsStack` in `packages/infra/bin/infra.ts` and make `LandingStack`/`ReleasesStack` depend on it

## 2. AnalyticsStack — log bucket

- [x] 2.1 Create `packages/infra/lib/AnalyticsStack/index.ts` with the shared log S3 bucket: block all public access, enforce SSL, S3-managed encryption, `RETAIN` removal, `ObjectOwnership.BUCKET_OWNER_PREFERRED` (ACLs enabled for legacy CloudFront log delivery)
- [x] 2.2 Add a lifecycle rule expiring log objects after the configured retention window (default 90 days)
- [x] 2.3 Publish the log bucket name to SSM (e.g. `/Argus/analytics/log-bucket-name`) and expose a `AnalyticsStack.getLogBucket(scope)` helper mirroring the `DnsStack` SSM pattern

## 3. AnalyticsStack — Athena/Glue query surface

- [x] 3.1 Create a Glue database for the analytics tables
- [x] 3.2 Define the `landing_logs` Glue external table (CloudFront standard-log schema, tab-delimited, header lines skipped) at the `landing/` prefix
- [x] 3.3 Define the `releases_logs` Glue external table at the `releases/` prefix
- [x] 3.4 Create an Athena workgroup with enforced results output location and a `BytesScannedCutoffPerQuery` cap
- [x] 3.5 Add the "visits per day" named query (successful HTML requests grouped by day + distinct-IP approximation) bound to the workgroup/database
- [x] 3.6 Add the "downloads by platform & version" named query (`200`/`206` requests to `.dmg`/`.msi`/`.AppImage`, grouped by installer key and version)
- [x] 3.7 Add CfnOutputs for the Glue database, workgroup, and log bucket names

## 4. Enable logging on the distributions

- [x] 4.1 In `LandingStack`, import the analytics log bucket and enable CloudFront standard logging with the `landing/` prefix
- [x] 4.2 In `ReleasesStack`, import the analytics log bucket and enable CloudFront standard logging with the `releases/` prefix, leaving OAC origin, manifest cache behaviors, and the publish role unchanged

## 5. Tests

- [x] 5.1 Add `packages/infra/test/AnalyticsStack.test.ts` asserting: private+ACL-enabled+retained log bucket, lifecycle expiration, Glue database + two tables over the correct prefixes, Athena workgroup with results location + scan cap, two named queries, and the SSM export
- [x] 5.2 Extend `LandingStack` / `ReleasesStack` tests to assert logging is enabled with the correct bucket and prefix and that no analytics script/cookie is added to the landing bundle
- [x] 5.3 Run `pnpm --filter infra test` (and `cdk synth`) to confirm all stacks synthesize and snapshots pass

## 6. Deploy & verify

- [x] 6.1 Deploy `AnalyticsStack`, then redeploy `LandingStack` and `ReleasesStack`
- [x] 6.2 After ~1 hour, confirm log objects appear under `landing/` and `releases/`, then run both named queries from Argus's Athena connection and sanity-check visit and download counts
- [x] 6.3 Update `README.md` (Context folders / infra section) and `CLAUDE.md` if needed to document the analytics log bucket, region coupling for Athena, and the two reporting queries
