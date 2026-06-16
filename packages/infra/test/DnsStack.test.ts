import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { DnsStack } from "../lib/DnsStack/index";

const testEnv = { account: "123456789012", region: "us-east-1" };

function buildTemplate(): Template {
  const app = new cdk.App();
  const stack = new DnsStack(app, "ArgusDnsStack", { env: testEnv });
  return Template.fromStack(stack);
}

describe("ArgusDnsStack", () => {
  let template: Template;

  beforeAll(() => {
    template = buildTemplate();
  });

  // ── Hosted Zone ────────────────────────────────────────────────────────────

  it("does NOT create a new hosted zone (imports existing one)", () => {
    template.resourceCountIs("AWS::Route53::HostedZone", 0);
  });

  // ── ACM Certificate ────────────────────────────────────────────────────────

  it("creates a wildcard ACM certificate for argusdb.app", () => {
    template.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: "argusdb.app",
      SubjectAlternativeNames: Match.arrayWith(["*.argusdb.app"]),
    });
  });

  it("uses DNS validation for the certificate", () => {
    template.hasResourceProperties("AWS::CertificateManager::Certificate", {
      ValidationMethod: "DNS",
    });
  });

  // ── SSM Parameters ─────────────────────────────────────────────────────────

  it("exports hostedZone/id to SSM under /Argus/DnsStack/", () => {
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/Argus/DnsStack/hostedZone/id",
    });
  });

  it("exports hostedZone/name to SSM under /Argus/DnsStack/", () => {
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/Argus/DnsStack/hostedZone/name",
    });
  });

  it("exports certificate/arn to SSM under /Argus/DnsStack/", () => {
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/Argus/DnsStack/certificate/arn",
    });
  });

  it("exports releases-public-url with value https://releases.argusdb.app", () => {
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/Argus/DnsStack/releases-public-url",
      Value: "https://releases.argusdb.app",
    });
  });
});
