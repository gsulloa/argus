## Why

The release artifacts are served from the raw CloudFront hostname
(`d15ks3oaq3fhx9.cloudfront.net`), which the Tauri updater bakes permanently
into every shipped binary. The domain `argusdb.app` is now registered in the
Argus AWS account (`862361086694`, `us-east-1`) with an auto-created public
hosted zone (`Z0157620NK45JFH3SPGW`). Putting the release endpoint behind a
custom subdomain — `releases.argusdb.app` — **before** the next bridge release
is the last cheap moment to do it: once the CloudFront hostname is baked into a
shipped binary, changing it requires another full bridge-release migration. A
custom domain makes the CDN behind it interchangeable forever without ever
touching installed clients.

## What Changes

- Add a new CDK **`ArgusDnsStack`** (`packages/infra/lib/DnsStack/`) that
  **imports** the existing `argusdb.app` hosted zone (it does NOT create one —
  the zone already exists from domain registration; creating a second would
  duplicate it with non-authoritative NS records) and re-exports its id/name via
  SSM + a static `getHostedZone()` getter, mirroring the Template `DnsStack`
  pattern so future stacks (landing page, etc.) reuse one zone.
- Modify **`ArgusReleasesStack`** to:
  - Create an ACM certificate for `releases.argusdb.app` with DNS validation
    against the imported zone (inline in `us-east-1`, since the whole account is
    `us-east-1` — no separate cross-region cert stack needed, unlike Template).
  - Attach the custom domain (`domainNames` + `certificate`) to the existing
    CloudFront distribution (`E2KQN4YB7WHWWS`).
  - Create a Route53 A/AAAA alias `releases.argusdb.app` → the distribution.
  - Export the public base URL `https://releases.argusdb.app` via SSM under
    `/Argus/releases/` for the release pipeline and updater endpoint to consume.
- Wire `ArgusDnsStack` into `bin/infra.ts` and add the `ArgusReleasesStack →
  ArgusDnsStack` dependency.
- Extend the infra Jest tests to assert the new domain/cert/alias resources.

Out of scope (belongs to the later cutover change): flipping the baked Tauri
updater endpoint, the bridge release, and decommissioning R2.

## Capabilities

### New Capabilities
- `dns-management`: A CDK stack that owns the shared `argusdb.app` Route53
  hosted zone for the project — importing the existing zone and exposing it to
  other stacks via SSM and a static getter — so DNS records and ACM certs across
  the account reference one canonical zone.

### Modified Capabilities
- `release-artifact-hosting`: The ReleasesStack now serves artifacts over the
  custom domain `releases.argusdb.app` (ACM cert + CloudFront alias + Route53
  alias record) and exports `https://releases.argusdb.app` as the public base
  URL, instead of relying solely on the raw CloudFront hostname.

## Impact

- **Infra code**: new `packages/infra/lib/DnsStack/`; edits to
  `packages/infra/lib/ReleasesStack/index.ts` and `packages/infra/bin/infra.ts`;
  new/updated tests under `packages/infra/test/`.
- **AWS resources** (account `862361086694`, `us-east-1`): one ACM certificate,
  Route53 records in `Z0157620NK45JFH3SPGW` (cert-validation CNAMEs + the
  `releases` alias), new SSM parameters, and an update to the live CloudFront
  distribution `E2KQN4YB7WHWWS` (adds aliases + viewer certificate).
- **Downstream (not in this change)**: the release pipeline's `PUBLIC_URL_BASE`
  and the Tauri updater endpoint will switch to `https://releases.argusdb.app`
  during the cutover.
- **No breaking change to installed clients**: the raw CloudFront hostname keeps
  working; the alias is additive.
