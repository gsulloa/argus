import * as path from "path";

import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import {
  DomainName,
  HttpApi,
  HttpMethod,
} from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { ARecord, RecordTarget } from "aws-cdk-lib/aws-route53";
import { ApiGatewayv2DomainProperties } from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

import {
  FEEDBACK_APP_KEY_SSM,
  FEEDBACK_ATTACHMENTS_BUCKET_ID,
  FEEDBACK_MAX_ATTACHMENT_BYTES,
  FEEDBACK_MAX_ATTACHMENTS,
  FEEDBACK_MAX_MESSAGE_CHARS,
  FEEDBACK_SUBDOMAIN,
  FEEDBACK_TABLE_NAME,
  PROJECT_NAME,
} from "@/constants";
import { NodejsFunctionBuilder } from "@/builders/NodejsFunctionBuilder";
import { DnsStack } from "@/lib/DnsStack/index";

export class FeedbackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── DynamoDB table ────────────────────────────────────────────────────────
    //
    // Single partition "FEEDBACK" with ULID sort key for chronological ordering.
    // On-demand billing; RETAIN so feedback survives a stack teardown.
    const table = new dynamodb.Table(this, "FeedbackTable", {
      tableName: FEEDBACK_TABLE_NAME,
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── Attachments S3 bucket ─────────────────────────────────────────────────
    //
    // All objects are private. The intake Lambda mints presigned PUT URLs so
    // the Rust client can upload directly, keeping blobs out of the API payload.
    const attachmentsBucket = new s3.Bucket(this, FEEDBACK_ATTACHMENTS_BUCKET_ID, {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    // ── DNS / Certificate (from DnsStack via SSM) ─────────────────────────────
    const hostedZone = DnsStack.getHostedZone(this);
    const certificate = DnsStack.getCertificate(this);

    // ── API Gateway v2 custom domain ──────────────────────────────────────────
    //
    // Regional endpoint — the cert can live in the stack region (no us-east-1
    // dance needed, unlike CloudFront).  DnsStack already provisions a wildcard
    // cert covering *.argusdb.app in us-east-1; for a regional API GW domain we
    // need the cert in the same region as the stack.  Because the wildcard cert
    // from DnsStack is in us-east-1 and this stack is deployed to the default
    // region we re-use DnsStack.getCertificate() which reads the ARN from SSM.
    // API GW v2 regional domains accept an ACM cert from the same region; if this
    // stack is deployed to us-east-1 the DnsStack cert is reusable directly.
    // If deployed to another region, a region-specific cert is needed — that
    // scenario is documented in the deviation notes.  For now we reuse the
    // DnsStack cert, which works when env region == us-east-1 (the common case
    // for this project; the operator should align the region or add a per-region
    // cert if needed).
    const domainName = new DomainName(this, "FeedbackDomain", {
      domainName: FEEDBACK_SUBDOMAIN,
      certificate,
    });

    // ── Intake Lambda ─────────────────────────────────────────────────────────
    //
    // App-key is stored as an SSM SecureString, provisioned/rotated by
    // scripts/set-feedback-app-key.sh (CDK cannot create SecureString
    // parameters). The Lambda fetches it at cold-start via ssm:GetParameter and
    // caches it for warm invocations. On rotation the script overwrites the SSM
    // parameter; the cache invalidates on the next auth failure.
    const intakeLambda = new NodejsFunctionBuilder(this, "FeedbackIntake", {
      entry: path.resolve(__dirname, "./handlers/intake.ts"),
      environment: {
        APP_KEY_SSM_PATH: FEEDBACK_APP_KEY_SSM,
        MAX_MESSAGE_CHARS: String(FEEDBACK_MAX_MESSAGE_CHARS),
        MAX_ATTACHMENTS: String(FEEDBACK_MAX_ATTACHMENTS),
        MAX_ATTACHMENT_BYTES: String(FEEDBACK_MAX_ATTACHMENT_BYTES),
      },
    })
      .grantDynamoDb({ table, permissions: "write" })
      .grantBucket({ bucket: attachmentsBucket, permissions: "write" })
      .build();

    // Grant the Lambda permission to read the SecureString app-key from SSM.
    intakeLambda.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "ReadAppKeyFromSsm",
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${FEEDBACK_APP_KEY_SSM}`,
        ],
      })
    );
    // Also allow KMS decrypt for the SecureString key (uses AWS-managed key).
    intakeLambda.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "DecryptSsmSecureString",
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: {
          StringEquals: {
            "kms:ViaService": `ssm.${this.region}.amazonaws.com`,
          },
        },
      })
    );

    // ── HTTP API (API Gateway v2) ─────────────────────────────────────────────
    //
    // createDefaultStage:true creates the $default stage automatically.
    // We attach the custom domain via defaultDomainMapping so the $default stage
    // is rooted at feedback.argusdb.app/.
    // Throttling is set on the $default stage via addStage after the fact —
    // HttpApi.createDefaultStage doesn't expose throttle directly, so we disable
    // the auto-stage and create it manually with throttle settings.
    const httpApi = new HttpApi(this, "FeedbackApi", {
      apiName: "ArgusFeedbackApi",
      description: "Argus feedback intake endpoint",
      createDefaultStage: false,
    });

    // Add the default stage with throttle settings and domain mapping.
    httpApi.addStage("DefaultStage", {
      stageName: "$default",
      autoDeploy: true,
      throttle: {
        rateLimit: 5,   // requests/second
        burstLimit: 10, // concurrent tokens
      },
      domainMapping: {
        domainName,
      },
    });

    // Add POST /feedback route.
    httpApi.addRoutes({
      path: "/feedback",
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration("FeedbackIntegration", intakeLambda),
    });

    // ── Route53 alias record ──────────────────────────────────────────────────
    new ARecord(this, "FeedbackAliasA", {
      zone: hostedZone,
      recordName: FEEDBACK_SUBDOMAIN,
      target: RecordTarget.fromAlias(
        new ApiGatewayv2DomainProperties(
          domainName.regionalDomainName,
          domainName.regionalHostedZoneId
        )
      ),
    });

    // ── CloudWatch alarm: abnormal invocation volume ──────────────────────────
    new cloudwatch.Alarm(this, "FeedbackIntakeInvocationsAlarm", {
      alarmName: "ArgusFeedbackIntake-HighInvocations",
      alarmDescription: "Lambda invocation count for FeedbackIntake exceeds expected volume",
      metric: intakeLambda.metricInvocations({
        period: cdk.Duration.minutes(5),
        statistic: "Sum",
      }),
      threshold: 100,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ── CfnOutputs ────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "FeedbackTableName", {
      value: table.tableName,
      description: "DynamoDB table for feedback items",
    });
    new cdk.CfnOutput(this, "FeedbackAttachmentsBucketName", {
      value: attachmentsBucket.bucketName,
      description: "S3 bucket for feedback attachments",
    });
    new cdk.CfnOutput(this, "FeedbackApiEndpoint", {
      value: `https://${FEEDBACK_SUBDOMAIN}`,
      description: "Feedback API custom-domain endpoint",
    });
    new cdk.CfnOutput(this, "FeedbackApiExecuteApiEndpoint", {
      value: httpApi.apiEndpoint,
      description: "Feedback API execute-api endpoint (fallback)",
    });

    // ── SSM exports ───────────────────────────────────────────────────────────
    const ssmPrefix = `/${PROJECT_NAME}/feedback`;
    new StringParameter(this, "SsmFeedbackTableName", {
      parameterName: `${ssmPrefix}/table-name`,
      stringValue: table.tableName,
    });
    new StringParameter(this, "SsmFeedbackBucketName", {
      parameterName: `${ssmPrefix}/bucket-name`,
      stringValue: attachmentsBucket.bucketName,
    });
    new StringParameter(this, "SsmFeedbackApiEndpoint", {
      parameterName: `${ssmPrefix}/api-endpoint`,
      stringValue: `https://${FEEDBACK_SUBDOMAIN}`,
    });
  }
}
