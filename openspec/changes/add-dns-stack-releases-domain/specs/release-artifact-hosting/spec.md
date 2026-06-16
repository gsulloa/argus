## ADDED Requirements

### Requirement: Artifacts are served over a custom release domain

The `ArgusReleasesStack` MUST serve release artifacts and manifests over the
custom subdomain `releases.argusdb.app`, in addition to the raw CloudFront
hostname (the alias is additive — the raw hostname keeps working). The stack
MUST obtain the wildcard ACM certificate and the hosted zone from
`ArgusDnsStack` (via `DnsStack.getCertificate(this)` and
`DnsStack.getHostedZone(this)`) — it MUST NOT create its own certificate or
hosted zone. The CloudFront distribution MUST declare `releases.argusdb.app` in
its `domainNames` and use that wildcard certificate as its viewer certificate.
The stack MUST create a Route53 alias record set (A and AAAA)
`releases.argusdb.app` → the CloudFront distribution in the imported hosted
zone. `ArgusReleasesStack` MUST declare an explicit dependency on
`ArgusDnsStack`.

#### Scenario: Distribution carries the custom alias and imported certificate

- **WHEN** `cdk synth` runs for `ArgusReleasesStack`
- **THEN** the `AWS::CloudFront::Distribution` lists `releases.argusdb.app` in
  its `Aliases` and its `ViewerCertificate` references the wildcard ACM
  certificate ARN imported from `ArgusDnsStack` (the stack synthesizes no
  `AWS::CertificateManager::Certificate` of its own)

#### Scenario: Route53 alias points the subdomain at CloudFront

- **WHEN** `cdk synth` runs for `ArgusReleasesStack`
- **THEN** the template contains `AWS::Route53::RecordSet` alias records (A and
  AAAA) named `releases.argusdb.app` targeting the CloudFront distribution

#### Scenario: Subdomain serves the manifest over HTTPS

- **WHEN** a client requests `https://releases.argusdb.app/latest.json` after
  deployment
- **THEN** CloudFront serves the manifest with a valid certificate for
  `releases.argusdb.app` and the same no-cache behavior as the raw hostname

## MODIFIED Requirements

### Requirement: Public base URL and identifiers are exported

The stack MUST expose the CloudFront public domain, the bucket name, the
distribution id, and the publish role ARN as `CfnOutput`s and as SSM Parameter
Store parameters under a `/${PROJECT_NAME}/releases/` namespace, so the release
pipeline and future consumers can discover them without hardcoding. The
**canonical custom base URL `https://releases.argusdb.app`** is owned and
exported by `ArgusDnsStack` at `/${PROJECT_NAME}/DnsStack/releases-public-url`
(not under `/releases/`), and is the value consumed by the release pipeline
(`PUBLIC_URL_BASE`) and the Tauri updater endpoint.

#### Scenario: Outputs are present after synth

- **WHEN** `cdk synth` runs for `ArgusReleasesStack`
- **THEN** the template includes `CfnOutput`s for the CloudFront domain and the
  publish role ARN, and `AWS::SSM::Parameter` resources under `/Argus/releases/`
  for the bucket name, distribution id, CloudFront domain, and publish role ARN
