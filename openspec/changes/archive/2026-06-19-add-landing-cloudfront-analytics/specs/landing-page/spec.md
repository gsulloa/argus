## ADDED Requirements

### Requirement: Landing distribution emits CloudFront standard access logs

The `LandingStack` CloudFront distribution MUST have standard access logging
enabled, delivering logs to the shared analytics log bucket (imported by name
from SSM) under the `landing/` prefix. Logging MUST NOT introduce any
client-side tracking, cookie, or analytics script into the landing bundle — the
page remains free of runtime analytics. The stack MUST depend on
`AnalyticsStack` so the log bucket exists before logging is enabled.

#### Scenario: Distribution is configured for standard logging

- **WHEN** `cdk synth` runs for `ArgusLandingStack`
- **THEN** the `AWS::CloudFront::Distribution` has logging enabled with the bucket
  set to the imported analytics log bucket and a `landing/` log file prefix

#### Scenario: No analytics script is added to the page

- **WHEN** the landing page is built and loaded
- **THEN** no GA4 / gtag / third-party analytics script and no tracking cookie is
  present; only server-side CloudFront logs capture the visit
