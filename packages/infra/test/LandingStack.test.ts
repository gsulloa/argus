import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { LandingStack } from "../lib/LandingStack/index";

const testEnv = { account: "123456789012", region: "us-east-1" };

// NOTE: LandingStack runs `execSync("pnpm run landing:build")` at synth time
// to build the Vite app. This means the test requires the Vite toolchain to be
// available and the build to succeed. The `dist/` folder is pre-built in the
// repo so the test should pass in CI if pnpm + vite are installed. If the build
// is too slow or unavailable, this test will fail at the buildTemplate() call
// with a non-zero exit code from the execSync.
function buildTemplate(): Template {
  const app = new cdk.App();
  const stack = new LandingStack(app, "ArgusLandingStack", { env: testEnv });
  return Template.fromStack(stack);
}

describe("ArgusLandingStack", () => {
  let template: Template;

  beforeAll(() => {
    template = buildTemplate();
  });

  // ── S3 Bucket ─────────────────────────────────────────────────────────────

  it("creates a private S3 bucket with all public-access blocks enabled", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it("retains the site bucket on stack deletion", () => {
    // The site bucket should be retained; the BucketDeployment helper bucket
    // may be destroyed — check at least one Retain policy is present.
    const buckets = template.findResources("AWS::S3::Bucket");
    const hasRetain = Object.values(buckets).some(
      (b: unknown) =>
        (b as { DeletionPolicy?: string }).DeletionPolicy === "Retain"
    );
    expect(hasRetain).toBe(true);
  });

  // ── CloudFront Distribution ───────────────────────────────────────────────

  it("creates exactly one CloudFront distribution", () => {
    template.resourceCountIs("AWS::CloudFront::Distribution", 1);
  });

  it("distribution uses REDIRECT_TO_HTTPS viewer protocol policy", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: "redirect-to-https",
        }),
      },
    });
  });

  it("distribution declares argusdb.app and www.argusdb.app aliases", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        Aliases: Match.arrayWith(["argusdb.app", "www.argusdb.app"]),
      },
    });
  });

  it("distribution has access logging enabled with prefix 'landing/'", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        Logging: Match.objectLike({
          Prefix: "landing/",
        }),
      },
    });
  });

  // ── Route53 Records ───────────────────────────────────────────────────────

  it("creates an A alias record for argusdb.app", () => {
    template.hasResourceProperties("AWS::Route53::RecordSet", {
      Type: "A",
      Name: "argusdb.app.",
    });
  });

  it("creates an AAAA alias record for argusdb.app", () => {
    template.hasResourceProperties("AWS::Route53::RecordSet", {
      Type: "AAAA",
      Name: "argusdb.app.",
    });
  });

  // ── CfnOutputs ────────────────────────────────────────────────────────────

  it("exports a CfnOutput for CloudFrontDomain", () => {
    const outputs = template.findOutputs("*");
    const hasCloudFront = Object.keys(outputs).some(
      (k) =>
        k.toLowerCase().includes("cloudfront") ||
        k.toLowerCase().includes("domain")
    );
    expect(hasCloudFront).toBe(true);
  });

  it("exports a CfnOutput for BucketName", () => {
    const outputs = template.findOutputs("*");
    const hasBucket = Object.keys(outputs).some((k) =>
      k.toLowerCase().includes("bucket")
    );
    expect(hasBucket).toBe(true);
  });

  // ── SSM Parameters ────────────────────────────────────────────────────────

  it("creates SSM parameters under /Argus/landing/", () => {
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: Match.stringLikeRegexp("^/Argus/landing/"),
    });
  });

  // ── No analytics JS ───────────────────────────────────────────────────────
  // The landing page must stay free of client-side analytics scripts.
  // This is a structural check — the distribution has no extra behaviors or
  // custom response headers that would inject tracking scripts.

  it("distribution has no CacheBehaviors for analytics or tracking paths", () => {
    const distributions = template.findResources(
      "AWS::CloudFront::Distribution"
    );
    const allBehaviors = Object.values(distributions).flatMap((d: unknown) => {
      const dist = d as {
        Properties?: {
          DistributionConfig?: { CacheBehaviors?: unknown[] };
        };
      };
      return dist.Properties?.DistributionConfig?.CacheBehaviors ?? [];
    });
    const hasAnalyticsPath = allBehaviors.some((b: unknown) => {
      const behavior = b as { PathPattern?: string };
      return (
        behavior.PathPattern?.includes("analytics") ||
        behavior.PathPattern?.includes("gtag") ||
        behavior.PathPattern?.includes("ga4")
      );
    });
    expect(hasAnalyticsPath).toBe(false);
  });
});
