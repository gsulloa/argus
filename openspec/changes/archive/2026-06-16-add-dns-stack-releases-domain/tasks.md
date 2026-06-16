## 1. Constants & DnsStack

- [x] 1.1 Add DNS constants to `packages/infra/constants.ts` (e.g. `DOMAIN_NAME = "argusdb.app"`, `HOSTED_ZONE_ID = "Z0157620NK45JFH3SPGW"`, `RELEASES_SUBDOMAIN = "releases.argusdb.app"`, `RELEASES_PUBLIC_URL = "https://releases.argusdb.app"`).
- [x] 1.2 Create `packages/infra/lib/DnsStack/index.ts` defining `ArgusDnsStack`: import the existing zone via `HostedZone.fromHostedZoneAttributes` (id + name from constants), NOT `new HostedZone`.
- [x] 1.3 Create a wildcard ACM `Certificate` in the stack: domainName `argusdb.app`, SAN `*.argusdb.app`, `CertificateValidation.fromDns(hostedZone)` (stack is us-east-1).
- [x] 1.4 Export to SSM under `/${PROJECT_NAME}/DnsStack/` (Template convention): `hostedZone/id`, `hostedZone/name`, certificate ARN, and `releases-public-url` = `https://releases.argusdb.app`.
- [x] 1.5 Add static helpers `getHostedZone(scope)` → `IHostedZone` and `getCertificate(scope)` → `ICertificate` (`Certificate.fromCertificateArn`), mirroring Template's getter API.

## 2. ReleasesStack custom domain

- [x] 2.1 In `ReleasesStack`, obtain the zone and certificate via `DnsStack.getHostedZone(this)` / `DnsStack.getCertificate(this)` (do NOT create a cert or zone here).
- [x] 2.2 Add `domainNames: ["releases.argusdb.app"]` + `certificate` to the existing CloudFront `Distribution` (preserve current OAC origin, manifest no-cache behaviors, HTTP/2+3, redirect-to-HTTPS).
- [x] 2.3 Create Route53 alias records `releases.argusdb.app` → the distribution: both `ARecord` and `AaaaRecord` with `RecordTarget.fromAlias(new CloudFrontTarget(distribution))`.

## 3. App wiring

- [x] 3.1 In `packages/infra/bin/infra.ts`, instantiate `ArgusDnsStack` (us-east-1 baseProps) and add `releasesStack.addDependency(dnsStack)`.

## 4. Tests

- [x] 4.1 Add a `DnsStack` synth test asserting: NO `AWS::Route53::HostedZone`, a wildcard `AWS::CertificateManager::Certificate` (`argusdb.app` + `*.argusdb.app`), and SSM `/Argus/DnsStack/` params (zone id/name, cert ARN, `releases-public-url`).
- [x] 4.2 Extend `ReleasesStack` synth tests: distribution has `releases.argusdb.app` in `Aliases` with a viewer certificate, A + AAAA alias `RecordSet`s exist, and the stack synthesizes no `AWS::CertificateManager::Certificate` of its own.
- [x] 4.3 `pnpm --filter infra build && pnpm --filter infra test` pass.

## 5. Deploy & verify

- [ ] 5.1 `pnpm --filter infra cdk diff ArgusDnsStack ArgusReleasesStack` — confirm no new hosted zone, one new wildcard ACM cert, distribution gains aliases + viewer cert, new alias records + SSM params.
- [ ] 5.2 Deploy `ArgusDnsStack` then `ArgusReleasesStack` (pass `--context githubOidcProviderArn=...` for the existing OIDC provider).
- [ ] 5.3 Verify: `dig releases.argusdb.app` resolves and `curl -I https://releases.argusdb.app/latest.json` returns 200 with a valid cert for the subdomain.
