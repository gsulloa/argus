## ADDED Requirements

### Requirement: Releases distribution emits CloudFront standard access logs

The `ReleasesStack` CloudFront distribution MUST have standard access logging
enabled, delivering logs to the shared analytics log bucket (imported by name
from SSM) under the `releases/` prefix, so that real installer downloads (the
file GET) are recorded. The stack MUST depend on `AnalyticsStack` so the log
bucket exists before logging is enabled. Enabling logging MUST NOT change the
existing OAC origin access, the manifest caching behaviors, or the GitHub OIDC
publish role.

#### Scenario: Distribution is configured for standard logging

- **WHEN** `cdk synth` runs for `ArgusReleasesStack`
- **THEN** the `AWS::CloudFront::Distribution` has logging enabled with the bucket
  set to the imported analytics log bucket and a `releases/` log file prefix

#### Scenario: Existing artifact-serving behavior is unchanged

- **WHEN** the stack is synthesized with logging enabled
- **THEN** the OAC S3 origin, the no-cache `latest.json` / `download.json`
  behaviors, and the publish role policy remain as previously specified
