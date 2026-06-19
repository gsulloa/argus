import { execSync } from "child_process";
import * as path from "path";

import * as cdk from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import { ARecord, AaaaRecord, RecordTarget } from "aws-cdk-lib/aws-route53";
import { CloudFrontTarget } from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

import {
  LANDING_DOMAIN,
  LANDING_LOG_PREFIX,
  LANDING_WWW_SUBDOMAIN,
  PROJECT_NAME,
} from "@/constants";
import { AnalyticsStack } from "@/lib/AnalyticsStack/index";
import { DnsStack } from "@/lib/DnsStack/index";

export class LandingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── DNS / Certificate (from DnsStack via SSM) ────────────────────────────
    const hostedZone = DnsStack.getHostedZone(this);
    const certificate = DnsStack.getCertificate(this);

    // ── Analytics log bucket (from AnalyticsStack via SSM) ───────────────────
    const logBucket = AnalyticsStack.getLogBucket(this);

    // ── S3 Bucket (private, served via CloudFront OAC) ───────────────────────
    const bucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(bucket);

    // ── CloudFront Distribution ──────────────────────────────────────────────
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      domainNames: [LANDING_DOMAIN, LANDING_WWW_SUBDOMAIN],
      certificate,
      enableLogging: true,
      logBucket,
      logFilePrefix: LANDING_LOG_PREFIX,
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.minutes(5),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.minutes(5),
        },
      ],
    });

    // ── Route53 Alias Records (apex + www) ───────────────────────────────────
    const recordTarget = RecordTarget.fromAlias(
      new CloudFrontTarget(distribution)
    );
    new ARecord(this, "LandingAliasA", {
      zone: hostedZone,
      recordName: LANDING_DOMAIN,
      target: recordTarget,
    });
    new AaaaRecord(this, "LandingAliasAaaa", {
      zone: hostedZone,
      recordName: LANDING_DOMAIN,
      target: recordTarget,
    });
    new ARecord(this, "LandingWwwAliasA", {
      zone: hostedZone,
      recordName: LANDING_WWW_SUBDOMAIN,
      target: recordTarget,
    });
    new AaaaRecord(this, "LandingWwwAliasAaaa", {
      zone: hostedZone,
      recordName: LANDING_WWW_SUBDOMAIN,
      target: recordTarget,
    });

    // ── Build the Vite app (synth time) ──────────────────────────────────────
    execSync("pnpm run landing:build", {
      cwd: path.resolve(__dirname, "../../"),
      stdio: "inherit",
      env: { ...process.env },
    });

    // ── Deploy built assets to S3 + invalidate CloudFront ────────────────────
    new BucketDeployment(this, "DeployLanding", {
      sources: [Source.asset(path.resolve(__dirname, "./app/dist"))],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ["/*"],
    });

    // ── Outputs ──────────────────────────────────────────────────────────────
    const ssmPrefix = `/${PROJECT_NAME}/landing`;
    new cdk.CfnOutput(this, "CloudFrontDomain", {
      value: distribution.distributionDomainName,
      description: "CloudFront distribution domain name",
    });
    new cdk.CfnOutput(this, "BucketName", {
      value: bucket.bucketName,
      description: "S3 site bucket name",
    });
    new cdk.CfnOutput(this, "DistributionId", {
      value: distribution.distributionId,
      description: "CloudFront distribution ID",
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
  }
}
