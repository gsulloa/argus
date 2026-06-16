## ADDED Requirements

### Requirement: Manifests serve CORS headers for the landing origin

The manifest cache behaviors MUST serve CORS headers permitting cross-origin reads from the landing origins. Concretely, the CloudFront cache behaviors for the manifest paths `download.json` and `latest.json` MUST attach a response-headers policy that returns CORS headers for the landing origins (`https://argusdb.app` and `https://www.argusdb.app`). The policy MUST allow the `GET` and `HEAD` methods and MUST NOT allow credentials. This enables the landing page, served from the apex domain, to fetch the manifest from `releases.argusdb.app` at runtime. The existing OAC origin protection and manifest-aware (no-cache) behavior for these paths MUST remain unchanged.

#### Scenario: Manifest response includes CORS headers for the landing origin

- **WHEN** a browser on `https://argusdb.app` fetches
  `https://releases.argusdb.app/download.json`
- **THEN** the response includes `Access-Control-Allow-Origin` for the landing
  origin and the fetch succeeds without a CORS error

#### Scenario: CORS policy is applied only to manifest behaviors

- **WHEN** `cdk synth` runs for `ArgusReleasesStack`
- **THEN** the `download.json` and `latest.json` cache behaviors reference a
  `ResponseHeadersPolicy` with a CORS config allowing `GET`/`HEAD` from the
  landing origins, while the default binary behavior does not

#### Scenario: Existing origin protection is preserved

- **WHEN** the CORS policy is added
- **THEN** the manifests are still served only via CloudFront OAC and still
  bypass the cache, with no change to the binary caching behavior
