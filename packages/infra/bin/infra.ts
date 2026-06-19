#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";

import { PROJECT_NAME } from "@/constants";
import { AnalyticsStack } from "@/lib/AnalyticsStack/index";
import { DnsStack } from "@/lib/DnsStack/index";
import { LandingStack } from "@/lib/LandingStack/index";
import { ReleasesStack } from "@/lib/ReleasesStack/index";

const baseProps = {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
};

const app = new cdk.App();

const dnsStack = new DnsStack(app, `${PROJECT_NAME}DnsStack`, { ...baseProps });

// Analytics stack provisions the shared log bucket and Athena/Glue surface.
// It has no DNS dependency but LandingStack and ReleasesStack depend on it
// so the log bucket exists before logging is enabled on the distributions.
const analyticsStack = new AnalyticsStack(app, `${PROJECT_NAME}AnalyticsStack`, { ...baseProps });

const releasesStack = new ReleasesStack(app, `${PROJECT_NAME}ReleasesStack`, { ...baseProps });
releasesStack.addDependency(dnsStack);
releasesStack.addDependency(analyticsStack);

const landingStack = new LandingStack(app, `${PROJECT_NAME}LandingStack`, {
  ...baseProps,
});
landingStack.addDependency(dnsStack);
landingStack.addDependency(analyticsStack);

app.synth();
