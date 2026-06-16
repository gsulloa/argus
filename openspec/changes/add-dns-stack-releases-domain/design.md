## Context

`argusdb.app` is registered in the Argus AWS account (`862361086694`, region
`us-east-1`) and Route53 already holds a **public hosted zone**
`Z0157620NK45JFH3SPGW` with only the default `NS` + `SOA` records — created
automatically by domain registration. `ArgusReleasesStack` is already deployed
(S3 + CloudFront `E2KQN4YB7WHWWS` + GitHub OIDC role); the distribution
currently has `Aliases: null` and uses the default `*.cloudfront.net`
certificate.

We want a dedicated DNS stack (mirroring the Template repo's `DnsStack`) and to
put the release endpoint behind `releases.argusdb.app`. The whole account lives
in `us-east-1`, which removes the cross-region certificate dance the Template
needs.

Constraint that dominates the design: the Tauri updater endpoint is **baked into
each shipped binary**. Establishing the custom domain now, before the next
bridge release, avoids a future forced migration. This change provisions the
DNS/cert infra only; flipping the baked endpoint is a later cutover change.

## Goals / Non-Goals

**Goals:**
- A reusable `ArgusDnsStack` that owns the canonical `argusdb.app` zone and hands
  an `IHostedZone` to other stacks.
- `releases.argusdb.app` fronting the existing CloudFront distribution with a
  valid ACM cert and a Route53 alias.
- Export `https://releases.argusdb.app` via SSM for the pipeline/updater.
- Additive, non-breaking: the raw CloudFront hostname keeps serving.

**Non-Goals:**
- Flipping the baked Tauri updater endpoint or cutting the bridge release.
- Decommissioning R2 / dual-publish.
- Apex (`argusdb.app`) or any non-release subdomain, landing page, email (MX),
  or CAA records.
- Taking full CloudFormation ownership of the hosted zone (see Decisions).

## Decisions

### Decision 1: Import the existing hosted zone — do NOT create one

Template does `new HostedZone(...)`. We cannot: the zone already exists and its
`NS` records are the authoritative delegation target for the registered domain.
A second CDK-created zone would have different `NS` records that nothing
delegates to, so records in it would never resolve.

**Choice:** `ArgusDnsStack` references the zone via
`HostedZone.fromHostedZoneAttributes(this, "Zone", { hostedZoneId, zoneName })`
with `hostedZoneId = Z0157620NK45JFH3SPGW` and `zoneName = "argusdb.app"`, stored
as constants. It re-exports id/name to SSM under `/Argus/dns/` and exposes a
static `getHostedZone(scope)` helper (parity with Template's getter API).

**Alternatives considered:**
- `HostedZone.fromLookup` — also works, but writes `cdk.context.json` and does a
  live account lookup at synth, making `cdk synth` non-hermetic in CI. Rejected
  in favor of explicit attributes for deterministic synth/tests. (Lookup remains
  a fine fallback if the id ever changes.)
- `cdk import` to adopt the zone into CloudFormation — gives full ownership but
  is a manual, stateful, error-prone step for a zone we're happy to leave managed
  by registration. Rejected: not worth the risk for two records.

### Decision 2: A wildcard ACM cert, owned by `ArgusDnsStack`, in us-east-1

The certificate is **wildcard** — `argusdb.app` with SAN `*.argusdb.app` (the
Template pattern) — so one cert covers `releases.argusdb.app` today and any
future subdomain (landing page, etc.). Because it is a **domain-level** asset
(not releases-specific), it lives in `ArgusDnsStack` alongside the zone, not in
`ArgusReleasesStack`. CloudFront viewer certs MUST be in `us-east-1`; the whole
account is already `us-east-1`, so the cert is a plain `Certificate` construct
inside `ArgusDnsStack`, DNS-validated against the imported zone — no separate
cross-region cert stack (which Template only needs because its primary region is
elsewhere).

`ArgusDnsStack` exports the cert ARN via SSM and exposes a static
`getCertificate(scope)` helper (`Certificate.fromCertificateArn`).
`ArgusReleasesStack` consumes it. Same region + account, so no
`crossRegionReferences`.

**Alternative:** an exact `releases.argusdb.app` cert inline in ReleasesStack —
rejected: a wildcard avoids minting a new cert per future subdomain, and a
domain-level cert belongs with the domain.

### Decision 3: DnsStack owns all domain-level facts (zone, cert, public URL)

`ArgusDnsStack` is the single owner of the domain: the imported zone, the
wildcard cert, and the canonical release URL `https://releases.argusdb.app`
(exported as `/Argus/DnsStack/releases-public-url`). SSM naming follows the
Template convention `/${PROJECT_NAME}/<StackName>/<resource>` (e.g.
`/Argus/DnsStack/hostedZone/id`). `ArgusReleasesStack` only owns what is coupled
to the distribution: the `domainNames` alias config and the Route53 alias
record, obtained via `DnsStack.getHostedZone(this)` / `getCertificate(this)`,
with `addDependency(dnsStack)`. This mirrors Template, where the consuming stack
creates only its A record.

### Decision 4: Alias both A and AAAA

CloudFront serves IPv4 and IPv6. Create alias record sets for both A and AAAA
(`ARecord` + `AaaaRecord` with `CloudFrontTarget`) so IPv6 clients resolve too.

## Risks / Trade-offs

- **[Mutating a live distribution]** Adding `domainNames` + a viewer cert
  triggers a CloudFront update (~deploys for several minutes). → Additive and
  safe: the raw hostname keeps working throughout; the default-cert path is
  unaffected for existing baked clients. No client points at the alias yet.
- **[ACM validation hangs]** DNS-validated certs block stack deploy until the
  validation CNAME resolves. Since CDK writes the CNAME into the same hosted
  zone we import, validation is automatic — but if the zone id is wrong the
  deploy stalls. → Mitigated by Decision 1's explicit, verified zone id and a
  synth test asserting no new zone is created.
- **[Hardcoded zone id]** `fromHostedZoneAttributes` bakes
  `Z0157620NK45JFH3SPGW` into code. → Acceptable: the zone is permanent for the
  life of the domain; documented as a constant. `fromLookup` is the escape hatch
  if it ever changes.
- **[Drift between SSM `cloudfront-domain` consumers and the new URL]** Existing
  consumers reading `/Argus/releases/cloudfront-domain` keep working; the new
  `public-url` parameter is added alongside, not replacing it. The pipeline
  switch is a separate cutover step.

## Migration Plan

1. `pnpm --filter infra build && pnpm --filter infra test` — synth + assertions
   green locally.
2. `pnpm --filter infra cdk diff ArgusDnsStack ArgusReleasesStack` — confirm: no
   new hosted zone, one new ACM cert, distribution gains aliases + viewer cert,
   new Route53 alias + SSM param.
3. `cdk deploy ArgusDnsStack` (no-op-ish: SSM params only), then
   `cdk deploy ArgusReleasesStack`. The OIDC provider already exists — pass
   `--context githubOidcProviderArn=...` as the existing stack does.
4. Verify: `dig releases.argusdb.app`, then
   `curl -I https://releases.argusdb.app/latest.json` returns 200 with a valid
   cert for the subdomain.
5. **Rollback:** revert the `ArgusReleasesStack` changes and redeploy — the
   distribution drops back to the default cert / no aliases; the imported zone is
   untouched (we never owned it). The standalone ACM cert is deleted on rollback.

## Resolved Decisions (previously open)

- **Wildcard cert** — confirmed: `argusdb.app` + SAN `*.argusdb.app`, owned by
  `ArgusDnsStack` (Decision 2/3).
- **SSM naming** — confirmed: Template convention `/Argus/DnsStack/<resource>`;
  the base URL is `/Argus/DnsStack/releases-public-url` =
  `https://releases.argusdb.app`.
