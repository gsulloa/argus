import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

import { PROJECT_NAME } from "@/constants";

export class ReleasesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── S3 Bucket ─────────────────────────────────────────────────────────────
    const bucket = new s3.Bucket(this, "ArtifactsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    // ── CloudFront Distribution ────────────────────────────────────────────────
    // Use the modern OAC helper — S3BucketOrigin.withOriginAccessControl
    // automatically wires the bucket policy to grant s3:GetObject to the
    // distribution only.
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(bucket);

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy:
          cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // Additional no-cache behaviors for the two manifest files so updated
      // manifests are visible immediately without waiting for TTL expiry.
      additionalBehaviors: {
        "latest.json": {
          origin: s3Origin,
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        },
        "download.json": {
          origin: s3Origin,
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        },
      },
    });

    // ── GitHub OIDC Publish Role ───────────────────────────────────────────────
    //
    // The GitHub OIDC provider (`token.actions.githubusercontent.com`) may
    // already exist in the AWS account — creating a second one would fail.
    // Guard with a CDK context flag:
    //   cdk deploy --context githubOidcProviderArn=arn:aws:iam::123:oidc-provider/...
    // When provided, we look up the existing provider; otherwise we create one.
    const existingProviderArn = this.node.tryGetContext(
      "githubOidcProviderArn"
    ) as string | undefined;

    const oidcProvider = existingProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
          this,
          "GithubOidcProvider",
          existingProviderArn
        )
      : new iam.OpenIdConnectProvider(this, "GithubOidcProvider", {
          url: "https://token.actions.githubusercontent.com",
          clientIds: ["sts.amazonaws.com"],
        });

    const publishRole = new iam.Role(this, "PublishRole", {
      assumedBy: new iam.WebIdentityPrincipal(oidcProvider.openIdConnectProviderArn, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        },
        StringLike: {
          "token.actions.githubusercontent.com:sub": "repo:gsulloa/argus:*",
        },
      }),
      description: "Assumed by GitHub Actions to publish Argus release artifacts",
    });

    // Least-privilege inline policy — no delete, no wildcards.
    publishRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "S3Objects",
        actions: ["s3:PutObject", "s3:GetObject"],
        resources: [`${bucket.bucketArn}/*`],
      })
    );
    publishRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "S3List",
        actions: ["s3:ListBucket"],
        resources: [bucket.bucketArn],
      })
    );
    publishRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "CloudFrontInvalidation",
        actions: ["cloudfront:CreateInvalidation"],
        resources: [
          `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
        ],
      })
    );

    // ── Outputs ───────────────────────────────────────────────────────────────
    const ssmPrefix = `/${PROJECT_NAME}/releases`;

    new cdk.CfnOutput(this, "CloudFrontDomain", {
      value: distribution.distributionDomainName,
      description: "CloudFront distribution domain name",
    });
    new cdk.CfnOutput(this, "BucketName", {
      value: bucket.bucketName,
      description: "S3 artifact bucket name",
    });
    new cdk.CfnOutput(this, "DistributionId", {
      value: distribution.distributionId,
      description: "CloudFront distribution ID",
    });
    new cdk.CfnOutput(this, "PublishRoleArn", {
      value: publishRole.roleArn,
      description: "IAM role ARN for GitHub Actions OIDC publish",
    });

    new ssm.StringParameter(this, "SsmCloudfrontDomain", {
      parameterName: `${ssmPrefix}/cloudfront-domain`,
      stringValue: distribution.distributionDomainName,
    });
    new ssm.StringParameter(this, "SsmBucketName", {
      parameterName: `${ssmPrefix}/bucket-name`,
      stringValue: bucket.bucketName,
    });
    new ssm.StringParameter(this, "SsmDistributionId", {
      parameterName: `${ssmPrefix}/distribution-id`,
      stringValue: distribution.distributionId,
    });
    new ssm.StringParameter(this, "SsmPublishRoleArn", {
      parameterName: `${ssmPrefix}/publish-role-arn`,
      stringValue: publishRole.roleArn,
    });
  }
}
