import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { AnalyticsStack } from "../lib/AnalyticsStack/index";

const testEnv = { account: "123456789012", region: "us-east-1" };

function buildTemplate(): Template {
  const app = new cdk.App();
  const stack = new AnalyticsStack(app, "ArgusAnalyticsStack", { env: testEnv });
  return Template.fromStack(stack);
}

describe("ArgusAnalyticsStack", () => {
  let template: Template;

  beforeAll(() => {
    template = buildTemplate();
  });

  // ── S3 Log Bucket ─────────────────────────────────────────────────────────

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

  it("sets ObjectOwnership to BucketOwnerPreferred so CloudFront ACL log delivery works", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      OwnershipControls: {
        Rules: Match.arrayWith([
          Match.objectLike({ ObjectOwnership: "BucketOwnerPreferred" }),
        ]),
      },
    });
  });

  it("adds a lifecycle rule expiring objects after 90 days", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ ExpirationInDays: 90, Status: "Enabled" }),
        ]),
      },
    });
  });

  it("retains the log bucket on stack deletion", () => {
    template.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Retain" });
  });

  // ── SSM Parameter ─────────────────────────────────────────────────────────

  it("publishes the bucket name to SSM at /Argus/analytics/log-bucket-name", () => {
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/Argus/analytics/log-bucket-name",
    });
  });

  // ── Glue Database ─────────────────────────────────────────────────────────

  it("creates exactly one Glue database", () => {
    template.resourceCountIs("AWS::Glue::Database", 1);
  });

  it("names the Glue database argus_analytics", () => {
    template.hasResourceProperties("AWS::Glue::Database", {
      DatabaseInput: { Name: "argus_analytics" },
    });
  });

  // ── Glue Tables ───────────────────────────────────────────────────────────

  it("creates exactly two Glue tables", () => {
    template.resourceCountIs("AWS::Glue::Table", 2);
  });

  it("landing_logs table has a StorageDescriptor Location containing 'landing/'", () => {
    // The Location is a CFn Fn::Join token (bucket name is dynamic), so we
    // inspect the join array for the "/landing/" suffix string.
    const tables = template.findResources("AWS::Glue::Table");
    const landingTable = Object.values(tables).find(
      (t: unknown) =>
        (t as { Properties?: { TableInput?: { Name?: string } } }).Properties?.TableInput?.Name === "landing_logs"
    );
    expect(landingTable).toBeDefined();
    const location = (landingTable as {
      Properties: { TableInput: { StorageDescriptor: { Location: unknown } } };
    }).Properties.TableInput.StorageDescriptor.Location;
    // Location is {"Fn::Join": ["", ["s3://", {"Ref": "..."}, "/landing/"]]}
    const joinParts = (location as { "Fn::Join": [string, unknown[]] })["Fn::Join"][1];
    const hasLandingPrefix = joinParts.some(
      (p: unknown) => typeof p === "string" && p.includes("landing/")
    );
    expect(hasLandingPrefix).toBe(true);
  });

  it("releases_logs table has a StorageDescriptor Location containing 'releases/'", () => {
    // The Location is a CFn Fn::Join token (bucket name is dynamic), so we
    // inspect the join array for the "/releases/" suffix string.
    const tables = template.findResources("AWS::Glue::Table");
    const releasesTable = Object.values(tables).find(
      (t: unknown) =>
        (t as { Properties?: { TableInput?: { Name?: string } } }).Properties?.TableInput?.Name === "releases_logs"
    );
    expect(releasesTable).toBeDefined();
    const location = (releasesTable as {
      Properties: { TableInput: { StorageDescriptor: { Location: unknown } } };
    }).Properties.TableInput.StorageDescriptor.Location;
    // Location is {"Fn::Join": ["", ["s3://", {"Ref": "..."}, "/releases/"]]}
    const joinParts = (location as { "Fn::Join": [string, unknown[]] })["Fn::Join"][1];
    const hasReleasesPrefix = joinParts.some(
      (p: unknown) => typeof p === "string" && p.includes("releases/")
    );
    expect(hasReleasesPrefix).toBe(true);
  });

  it("Glue tables use LazySimpleSerDe with tab delimiter", () => {
    template.hasResourceProperties("AWS::Glue::Table", {
      TableInput: {
        StorageDescriptor: {
          SerdeInfo: {
            SerializationLibrary:
              "org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe",
            Parameters: { "field.delim": "\t" },
          },
        },
      },
    });
  });

  it("Glue tables skip 2 header lines", () => {
    template.hasResourceProperties("AWS::Glue::Table", {
      TableInput: {
        Parameters: Match.objectLike({ "skip.header.line.count": "2" }),
      },
    });
  });

  // ── Athena WorkGroup ──────────────────────────────────────────────────────

  it("creates an Athena workgroup named argus-analytics", () => {
    template.hasResourceProperties("AWS::Athena::WorkGroup", {
      Name: "argus-analytics",
    });
  });

  it("workgroup enforces configuration and has a bytes-scanned cap", () => {
    template.hasResourceProperties("AWS::Athena::WorkGroup", {
      WorkGroupConfiguration: {
        EnforceWorkGroupConfiguration: true,
        BytesScannedCutoffPerQuery: 1_000_000_000,
      },
    });
  });

  // ── Athena Named Queries ──────────────────────────────────────────────────

  it("creates exactly two named queries", () => {
    template.resourceCountIs("AWS::Athena::NamedQuery", 2);
  });

  it("visits-per-day named query targets the analytics database and workgroup", () => {
    template.hasResourceProperties("AWS::Athena::NamedQuery", {
      Name: "visits-per-day",
      Database: "argus_analytics",
      WorkGroup: "argus-analytics",
    });
  });

  it("downloads-by-platform-version named query targets the analytics database and workgroup", () => {
    template.hasResourceProperties("AWS::Athena::NamedQuery", {
      Name: "downloads-by-platform-version",
      Database: "argus_analytics",
      WorkGroup: "argus-analytics",
    });
  });

  it("named queries declare an explicit DependsOn the workgroup (referenced by name, not Ref)", () => {
    const wgIds = Object.keys(template.findResources("AWS::Athena::WorkGroup"));
    expect(wgIds).toHaveLength(1);
    const queries = template.findResources("AWS::Athena::NamedQuery");
    const ids = Object.values(queries).map(
      (q) => (q as { DependsOn?: string[] | string }).DependsOn
    );
    expect(ids).toHaveLength(2);
    for (const dep of ids) {
      const deps = Array.isArray(dep) ? dep : [dep];
      expect(deps).toContain(wgIds[0]);
    }
  });

  // ── CfnOutputs ───────────────────────────────────────────────────────────

  it("exports a CfnOutput for GlueDatabaseName", () => {
    const outputs = template.findOutputs("*");
    const hasDb = Object.keys(outputs).some((k) =>
      k.toLowerCase().includes("database") || k.toLowerCase().includes("glue")
    );
    expect(hasDb).toBe(true);
  });

  it("exports a CfnOutput for AthenaWorkgroupName", () => {
    const outputs = template.findOutputs("*");
    const hasWg = Object.keys(outputs).some((k) =>
      k.toLowerCase().includes("workgroup") || k.toLowerCase().includes("athena")
    );
    expect(hasWg).toBe(true);
  });

  it("exports a CfnOutput for LogBucketName", () => {
    const outputs = template.findOutputs("*");
    const hasBucket = Object.keys(outputs).some((k) =>
      k.toLowerCase().includes("bucket") || k.toLowerCase().includes("log")
    );
    expect(hasBucket).toBe(true);
  });
});
