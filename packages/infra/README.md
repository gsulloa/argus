# Argus Infrastructure

AWS CDK package for the Argus desktop app infrastructure. This package manages all cloud resources deployed via CDK.

## Conventions

Inherited from the [Template project](https://github.com/inventures/template):

- **Stack-per-directory** — each stack lives under `lib/<StackName>/`. The stack class is the default export of `lib/<StackName>/index.ts`.
- **`NodejsFunctionBuilder`** — all Lambda functions are created via `builders/NodejsFunctionBuilder.ts`. It sets Node 22, 512 MB, 30 s timeout by default and exposes fluent methods (`addSchedule`, `grantBucket`, `grantSes`, `invokeOn`).
- **SSM-getter cross-stack pattern** — stacks export values via SSM Parameter Store; dependent stacks read them at synth time using SSM lookups (avoids hard CloudFormation cross-stack references).
- **Middy handlers** — Lambda handlers use [Middy](https://middy.js.org/) middleware. `withEventSchema` validates the event with Zod; `loggerWithContext` attaches the Lambda context to the Powertools logger.

## Current state

Skeleton only — no stacks yet. The CDK app synthesizes to an empty cloud assembly (valid).

## Planned stacks

| Stack | Purpose |
|---|---|
| `ReleasesStack` | Release artifact hosting on AWS (S3 bucket + CloudFront distribution) |
| `FrontendStack` | React + Vite landing page hosted on S3 + CloudFront |

## Commands

```bash
# Type-check (no emit)
pnpm --filter infra build

# Synthesize CloudFormation templates
pnpm --filter infra cdk synth

# Run tests
pnpm --filter infra test

# CDK CLI (pass any cdk subcommand)
pnpm --filter infra cdk -- <subcommand>
```

Or use the root shortcuts:

```bash
pnpm infra:build
pnpm infra:synth
```
