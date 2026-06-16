import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { ReleasesStack } from "../lib/ReleasesStack/index";

const testEnv = { account: "123456789012", region: "us-east-1" };

function buildTemplate(): Template {
  const app = new cdk.App();
  const stack = new ReleasesStack(app, "ArgusReleasesStack", { env: testEnv });
  return Template.fromStack(stack);
}

describe("ArgusReleasesStack", () => {
  let template: Template;

  beforeAll(() => {
    template = buildTemplate();
  });

  // ── S3 Bucket ──────────────────────────────────────────────────────────────

  it("creates a private S3 bucket with all public-access settings blocked", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it("enables versioning on the S3 bucket", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      VersioningConfiguration: { Status: "Enabled" },
    });
  });

  it("retains the S3 bucket on stack deletion", () => {
    template.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Retain" });
  });

  // ── CloudFront ─────────────────────────────────────────────────────────────

  it("creates a CloudFront distribution", () => {
    template.resourceCountIs("AWS::CloudFront::Distribution", 1);
  });

  it("creates an OriginAccessControl resource", () => {
    template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
  });

  it("includes a CacheBehavior for latest.json (no-cache)", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({ PathPattern: "latest.json" }),
        ]),
      },
    });
  });

  it("includes a CacheBehavior for download.json (no-cache)", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({ PathPattern: "download.json" }),
        ]),
      },
    });
  });

  // ── Bucket policy grants s3:GetObject only to CloudFront ──────────────────

  it("bucket policy grants s3:GetObject to the CloudFront service principal", () => {
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "s3:GetObject",
          }),
        ]),
      },
    });
  });

  // ── IAM Role (GitHub OIDC) ─────────────────────────────────────────────────

  it("creates an IAM role that trusts the GitHub OIDC provider", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: Match.objectLike({
              Federated: Match.anyValue(),
            }),
          }),
        ]),
      },
    });
  });

  it("OIDC trust policy conditions include repo:gsulloa/argus:* subject and sts.amazonaws.com aud", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Condition: Match.objectLike({
              StringEquals: Match.objectLike({
                "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
              }),
              StringLike: Match.objectLike({
                "token.actions.githubusercontent.com:sub": "repo:gsulloa/argus:*",
              }),
            }),
          }),
        ]),
      },
    });
  });

  it("role inline policy includes cloudfront:CreateInvalidation", () => {
    // The CloudFront invalidation statement has a single-string Action, not an array.
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "cloudfront:CreateInvalidation",
          }),
        ]),
      },
    });
  });

  it("role inline policy includes s3:PutObject", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["s3:PutObject"]),
          }),
        ]),
      },
    });
  });

  it("role inline policy does NOT include s3:DeleteObject", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const allStatements: unknown[] = Object.values(policies).flatMap(
      (p: unknown) => {
        const policy = p as { Properties?: { PolicyDocument?: { Statement?: unknown[] } } };
        return policy.Properties?.PolicyDocument?.Statement ?? [];
      }
    );
    const hasDelete = allStatements.some((stmt) => {
      const s = stmt as { Action?: unknown };
      if (!s.Action) return false;
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.some(
        (a: unknown) => typeof a === "string" && a.includes("s3:DeleteObject")
      );
    });
    expect(hasDelete).toBe(false);
  });

  // ── CfnOutputs ────────────────────────────────────────────────────────────

  it("exports a CfnOutput for CloudFrontDomain", () => {
    const outputs = template.findOutputs("*");
    const keys = Object.keys(outputs);
    const hasCloudFrontDomain = keys.some((k) =>
      k.toLowerCase().includes("cloudfront") || k.toLowerCase().includes("domain")
    );
    expect(hasCloudFrontDomain).toBe(true);
  });

  it("exports a CfnOutput for PublishRoleArn", () => {
    const outputs = template.findOutputs("*");
    const keys = Object.keys(outputs);
    const hasRoleArn = keys.some(
      (k) => k.toLowerCase().includes("role") || k.toLowerCase().includes("publish")
    );
    expect(hasRoleArn).toBe(true);
  });

  // ── SSM Parameters ────────────────────────────────────────────────────────

  it("creates SSM parameters under /Argus/releases/", () => {
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: Match.stringLikeRegexp("^/Argus/releases/"),
    });
  });

  it("creates SSM parameter for cloudfront-domain", () => {
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/Argus/releases/cloudfront-domain",
    });
  });

  it("creates SSM parameter for publish-role-arn", () => {
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/Argus/releases/publish-role-arn",
    });
  });
});
