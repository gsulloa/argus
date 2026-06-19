import * as cdk from "aws-cdk-lib";
import * as athena from "aws-cdk-lib/aws-athena";
import * as glue from "aws-cdk-lib/aws-glue";
import * as s3 from "aws-cdk-lib/aws-s3";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

import {
  ANALYTICS_GLUE_DATABASE,
  ANALYTICS_LOG_BUCKET_SSM,
  ANALYTICS_LOG_RETENTION_DAYS,
  ANALYTICS_WORKGROUP,
  LANDING_LOG_PREFIX,
  RELEASES_LOG_PREFIX,
} from "@/constants";

// ── CloudFront standard-log column schema ─────────────────────────────────
// Canonical field order from CloudFront documentation.
// Column names use underscores (Hive/Athena convention).
// "date" and "time" are reserved words in Presto/Athena, so we use
// request_date and request_time instead.
const CLOUDFRONT_LOG_COLUMNS: glue.CfnTable.ColumnProperty[] = [
  { name: "request_date", type: "date" },
  { name: "request_time", type: "string" },
  { name: "x_edge_location", type: "string" },
  { name: "sc_bytes", type: "bigint" },
  { name: "c_ip", type: "string" },
  { name: "cs_method", type: "string" },
  { name: "cs_host", type: "string" },
  { name: "cs_uri_stem", type: "string" },
  { name: "sc_status", type: "int" },
  { name: "cs_referer", type: "string" },
  { name: "cs_user_agent", type: "string" },
  { name: "cs_uri_query", type: "string" },
  { name: "cs_cookie", type: "string" },
  { name: "x_edge_result_type", type: "string" },
  { name: "x_edge_request_id", type: "string" },
  { name: "x_host_header", type: "string" },
  { name: "cs_protocol", type: "string" },
  { name: "cs_bytes", type: "bigint" },
  { name: "time_taken", type: "float" },
  { name: "x_forwarded_for", type: "string" },
  { name: "ssl_protocol", type: "string" },
  { name: "ssl_cipher", type: "string" },
  { name: "x_edge_response_result_type", type: "string" },
  { name: "cs_protocol_version", type: "string" },
  { name: "fle_status", type: "string" },
  { name: "fle_encrypted_fields", type: "int" },
  { name: "c_port", type: "int" },
  { name: "time_to_first_byte", type: "float" },
  { name: "x_edge_detailed_result_type", type: "string" },
  { name: "sc_content_type", type: "string" },
  { name: "sc_content_len", type: "bigint" },
  { name: "sc_range_start", type: "bigint" },
  { name: "sc_range_end", type: "bigint" },
];

/** Build a CloudFront standard-log external Glue table. */
function buildLogTable(
  scope: Construct,
  id: string,
  tableName: string,
  databaseName: string,
  s3Location: string
): glue.CfnTable {
  return new glue.CfnTable(scope, id, {
    catalogId: (scope as cdk.Stack).account,
    databaseName,
    tableInput: {
      name: tableName,
      tableType: "EXTERNAL_TABLE",
      parameters: {
        // CloudFront standard logs have 2 comment/version header lines.
        "skip.header.line.count": "2",
        EXTERNAL: "TRUE",
        classification: "csv",
      },
      storageDescriptor: {
        columns: CLOUDFRONT_LOG_COLUMNS,
        location: s3Location,
        inputFormat: "org.apache.hadoop.mapred.TextInputFormat",
        outputFormat: "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
        serdeInfo: {
          serializationLibrary: "org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe",
          parameters: {
            // CloudFront standard logs are tab-delimited.
            "field.delim": "\t",
          },
        },
        compressed: false,
        numberOfBuckets: -1,
        storedAsSubDirectories: false,
      },
    },
  });
}

export class AnalyticsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── Shared CloudFront access-log bucket ──────────────────────────────────
    //
    // ObjectOwnership MUST be BUCKET_OWNER_PREFERRED (i.e., ACLs enabled) so
    // that the legacy CloudFront standard-log delivery service can write objects
    // using the bucket-owner-full-control canned ACL. Without this, CloudFront
    // log delivery silently fails because the default ObjectOwnership
    // BUCKET_OWNER_ENFORCED disables ACLs entirely and rejects those writes.
    const logBucket = new s3.Bucket(this, "LogBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      lifecycleRules: [
        {
          id: "ExpireLogObjects",
          enabled: true,
          expiration: cdk.Duration.days(ANALYTICS_LOG_RETENTION_DAYS),
        },
      ],
    });

    // ── SSM export ───────────────────────────────────────────────────────────
    new StringParameter(this, "SsmLogBucketName", {
      parameterName: ANALYTICS_LOG_BUCKET_SSM,
      stringValue: logBucket.bucketName,
    });

    // ── Glue database ────────────────────────────────────────────────────────
    const glueDatabase = new glue.CfnDatabase(this, "GlueDatabase", {
      catalogId: this.account,
      databaseInput: {
        name: ANALYTICS_GLUE_DATABASE,
      },
    });

    // ── Glue external tables (CloudFront standard-log format) ─────────────────
    const landingTable = buildLogTable(
      this,
      "GlueLandingLogsTable",
      "landing_logs",
      ANALYTICS_GLUE_DATABASE,
      `s3://${logBucket.bucketName}/${LANDING_LOG_PREFIX}`
    );
    landingTable.addDependency(glueDatabase);

    const releasesTable = buildLogTable(
      this,
      "GlueReleasesLogsTable",
      "releases_logs",
      ANALYTICS_GLUE_DATABASE,
      `s3://${logBucket.bucketName}/${RELEASES_LOG_PREFIX}`
    );
    releasesTable.addDependency(glueDatabase);

    // ── Athena workgroup ──────────────────────────────────────────────────────
    const workgroup = new athena.CfnWorkGroup(this, "AthenaWorkgroup", {
      name: ANALYTICS_WORKGROUP,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        bytesScannedCutoffPerQuery: 1_000_000_000, // 1 GB safety cap
        resultConfiguration: {
          outputLocation: `s3://${logBucket.bucketName}/results/`,
        },
      },
    });

    // ── Named query: visits per day ───────────────────────────────────────────
    const visitsQuery = new athena.CfnNamedQuery(this, "QueryVisitsPerDay", {
      name: "visits-per-day",
      database: ANALYTICS_GLUE_DATABASE,
      workGroup: workgroup.name,
      queryString: [
        "SELECT",
        "  request_date AS day,",
        "  COUNT(*) AS requests,",
        "  COUNT(DISTINCT c_ip) AS approx_unique_ips",
        `FROM ${ANALYTICS_GLUE_DATABASE}.landing_logs`,
        "WHERE sc_status = 200",
        "  AND (cs_uri_stem = '/' OR cs_uri_stem LIKE '%.html')",
        "  AND lower(cs_user_agent) NOT LIKE '%bot%'",
        "GROUP BY request_date",
        "ORDER BY day DESC;",
      ].join("\n"),
    });
    visitsQuery.addDependency(workgroup);

    // ── Named query: downloads by platform & version ──────────────────────────
    const downloadsQuery = new athena.CfnNamedQuery(this, "QueryDownloadsByPlatformVersion", {
      name: "downloads-by-platform-version",
      database: ANALYTICS_GLUE_DATABASE,
      workGroup: workgroup.name,
      queryString: [
        "SELECT",
        "  CASE",
        "    WHEN cs_uri_stem LIKE '%.dmg' THEN 'macOS'",
        "    WHEN cs_uri_stem LIKE '%.msi' THEN 'Windows'",
        "    WHEN cs_uri_stem LIKE '%.AppImage' THEN 'Linux'",
        "  END AS platform,",
        "  regexp_extract(cs_uri_stem, '[0-9]+\\.[0-9]+\\.[0-9]+') AS version,",
        "  COUNT(*) AS downloads",
        `FROM ${ANALYTICS_GLUE_DATABASE}.releases_logs`,
        "WHERE sc_status IN (200, 206)",
        "  AND (cs_uri_stem LIKE '%.dmg' OR cs_uri_stem LIKE '%.msi' OR cs_uri_stem LIKE '%.AppImage')",
        "GROUP BY 1, 2",
        "ORDER BY downloads DESC;",
      ].join("\n"),
    });
    downloadsQuery.addDependency(workgroup);

    // ── CfnOutputs ────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "GlueDatabaseName", {
      value: ANALYTICS_GLUE_DATABASE,
      description: "Glue database name for CloudFront access logs",
    });
    new cdk.CfnOutput(this, "AthenaWorkgroupName", {
      value: ANALYTICS_WORKGROUP,
      description: "Athena workgroup for analytics queries",
    });
    new cdk.CfnOutput(this, "LogBucketName", {
      value: logBucket.bucketName,
      description: "S3 bucket receiving CloudFront access logs",
    });
  }

  // ── Static helper (mirrors DnsStack getter pattern) ──────────────────────

  /**
   * Import the shared analytics log bucket by name from SSM.
   * Consuming stacks (LandingStack, ReleasesStack) call this to resolve the
   * bucket reference so they can pass it to their CloudFront distribution's
   * `logBucket` prop.
   */
  static getLogBucket(scope: Construct): s3.IBucket {
    const bucketName = StringParameter.valueForStringParameter(
      scope,
      ANALYTICS_LOG_BUCKET_SSM
    );
    return s3.Bucket.fromBucketName(
      scope,
      `${scope.node.id}AnalyticsLogBucket`,
      bucketName
    );
  }
}
