import * as cdk from "aws-cdk-lib";
import { Certificate, CertificateValidation, ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import { HostedZone, IHostedZone } from "aws-cdk-lib/aws-route53";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

import {
  DOMAIN_NAME,
  HOSTED_ZONE_ID,
  PROJECT_NAME,
  RELEASES_PUBLIC_URL,
} from "@/constants";

// ── SSM parameter names ────────────────────────────────────────────────────
const SSM_HOSTED_ZONE_ID = `/${PROJECT_NAME}/DnsStack/hostedZone/id`;
const SSM_HOSTED_ZONE_NAME = `/${PROJECT_NAME}/DnsStack/hostedZone/name`;
const SSM_CERTIFICATE_ARN = `/${PROJECT_NAME}/DnsStack/certificate/arn`;
const SSM_RELEASES_PUBLIC_URL = `/${PROJECT_NAME}/DnsStack/releases-public-url`;

export class DnsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── Hosted Zone (imported — already exists in the account) ────────────────
    const hostedZone = HostedZone.fromHostedZoneAttributes(this, "HostedZone", {
      hostedZoneId: HOSTED_ZONE_ID,
      zoneName: DOMAIN_NAME,
    });

    // ── Wildcard ACM Certificate ───────────────────────────────────────────────
    // Wildcard covers releases.argusdb.app today and any future subdomain.
    // DNS-validated against the imported zone; same region (us-east-1) so no
    // cross-region dance is needed.
    const certificate = new Certificate(this, "DomainCertificate", {
      domainName: DOMAIN_NAME,
      subjectAlternativeNames: [`*.${DOMAIN_NAME}`],
      validation: CertificateValidation.fromDns(hostedZone),
    });

    // ── SSM exports ───────────────────────────────────────────────────────────
    new StringParameter(this, "SsmHostedZoneId", {
      parameterName: SSM_HOSTED_ZONE_ID,
      stringValue: hostedZone.hostedZoneId,
    });
    new StringParameter(this, "SsmHostedZoneName", {
      parameterName: SSM_HOSTED_ZONE_NAME,
      stringValue: hostedZone.zoneName,
    });
    new StringParameter(this, "SsmCertificateArn", {
      parameterName: SSM_CERTIFICATE_ARN,
      stringValue: certificate.certificateArn,
    });
    new StringParameter(this, "SsmReleasesPublicUrl", {
      parameterName: SSM_RELEASES_PUBLIC_URL,
      stringValue: RELEASES_PUBLIC_URL,
    });
  }

  // ── Static helpers (mirror Template's getter API) ─────────────────────────

  /**
   * Read the imported hosted zone; usable by any consuming stack.
   *
   * The zone id is read from SSM (runtime-discoverable), but the zone NAME uses
   * the `DOMAIN_NAME` compile-time constant on purpose: a concrete zone name
   * lets CDK correctly resolve fully-qualified record names. If the name were a
   * token, CDK could not tell that an FQDN `recordName` already ends with the
   * zone and would append the zone again (e.g. `releases.argusdb.app.argusdb.app.`).
   */
  static getHostedZone(scope: Construct): IHostedZone {
    const hostedZoneId = StringParameter.valueForStringParameter(
      scope,
      SSM_HOSTED_ZONE_ID
    );
    return HostedZone.fromHostedZoneAttributes(
      scope,
      `${scope.node.id}HostedZone`,
      { hostedZoneId, zoneName: DOMAIN_NAME }
    );
  }

  /** Read the wildcard cert ARN from SSM; usable by any consuming stack. */
  static getCertificate(scope: Construct): ICertificate {
    const arn = StringParameter.valueForStringParameter(
      scope,
      SSM_CERTIFICATE_ARN
    );
    return Certificate.fromCertificateArn(
      scope,
      `${scope.node.id}Certificate`,
      arn
    );
  }
}
