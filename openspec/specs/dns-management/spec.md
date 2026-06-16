# dns-management Specification

## Purpose
TBD - created by syncing change add-dns-stack-releases-domain. Update Purpose after sync.
## Requirements
### Requirement: DnsStack imports and exposes the project hosted zone

The `packages/infra` CDK app SHALL define a stack named
`${PROJECT_NAME}DnsStack` (`ArgusDnsStack`) under `lib/DnsStack/`, instantiated
in `bin/infra.ts` in `us-east-1`. The stack MUST reference the project's
pre-existing public Route53 hosted zone for `argusdb.app` by **importing** it
(via `HostedZone.fromHostedZoneAttributes` using the known hosted-zone id and
zone name, or `HostedZone.fromLookup`). The stack MUST NOT create a new
`AWS::Route53::HostedZone`, because the zone already exists from domain
registration and a second zone would publish non-authoritative NS records.

#### Scenario: Synthesized template creates no new hosted zone

- **WHEN** `cdk synth` runs for `ArgusDnsStack`
- **THEN** the template contains no `AWS::Route53::HostedZone` resource, and the
  stack instead resolves the existing zone by id/name

#### Scenario: Imported zone matches the registered domain

- **WHEN** the stack resolves the hosted zone
- **THEN** the resolved `zoneName` is `argusdb.app` and the hosted-zone id is the
  registered zone (`Z0157620NK45JFH3SPGW`)

### Requirement: Hosted zone is discoverable by other stacks

The stack MUST expose the hosted-zone id and name as SSM Parameter Store
parameters under the `/${PROJECT_NAME}/DnsStack/` namespace (Template
convention), and MUST provide a static `getHostedZone(scope)` helper that other
stacks call to obtain an `IHostedZone` without hardcoding the id. This keeps a
single canonical zone shared across the account (releases, future landing page,
etc.).

#### Scenario: Zone identifiers are exported to SSM

- **WHEN** `cdk synth` runs for `ArgusDnsStack`
- **THEN** the template includes `AWS::SSM::Parameter` resources under
  `/Argus/DnsStack/` carrying the hosted-zone id and name

#### Scenario: Another stack resolves the zone via the helper

- **WHEN** a consuming stack calls `DnsStack.getHostedZone(this)`
- **THEN** it receives an `IHostedZone` for `argusdb.app` suitable for creating
  records and validating ACM certificates, without hardcoding the zone id

### Requirement: DnsStack owns a wildcard ACM certificate for the domain

The stack MUST create a single wildcard ACM `Certificate` in `us-east-1`
(the region CloudFront requires) with domain name `argusdb.app` and subject
alternative name `*.argusdb.app`, validated by DNS against the imported hosted
zone. This domain-level certificate covers `releases.argusdb.app` and any future
subdomain. The stack MUST export the certificate ARN as an SSM parameter under
`/${PROJECT_NAME}/DnsStack/` and provide a static `getCertificate(scope)` helper
returning an `ICertificate` (via `Certificate.fromCertificateArn`).

#### Scenario: Wildcard certificate is synthesized and exported

- **WHEN** `cdk synth` runs for `ArgusDnsStack`
- **THEN** the template contains an `AWS::CertificateManager::Certificate` for
  `argusdb.app` with SAN `*.argusdb.app` and DNS validation, plus an
  `AWS::SSM::Parameter` under `/Argus/DnsStack/` holding its ARN

#### Scenario: Another stack resolves the certificate via the helper

- **WHEN** a consuming stack calls `DnsStack.getCertificate(this)`
- **THEN** it receives an `ICertificate` usable as a CloudFront viewer
  certificate, without hardcoding the ARN

### Requirement: Canonical release URL is exported

The stack MUST export the canonical release base URL
`https://releases.argusdb.app` as an SSM parameter at
`/${PROJECT_NAME}/DnsStack/releases-public-url`, so the release pipeline
(`PUBLIC_URL_BASE`) and the Tauri updater endpoint discover it without
hardcoding.

#### Scenario: Release URL parameter is present

- **WHEN** `cdk synth` runs for `ArgusDnsStack`
- **THEN** the template includes an `AWS::SSM::Parameter` named
  `/Argus/DnsStack/releases-public-url` with value `https://releases.argusdb.app`
