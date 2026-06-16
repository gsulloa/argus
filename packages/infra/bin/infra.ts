#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";

import { PROJECT_NAME } from "@/constants";
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

const releasesStack = new ReleasesStack(app, `${PROJECT_NAME}ReleasesStack`, { ...baseProps });
releasesStack.addDependency(dnsStack);

const landingStack = new LandingStack(app, `${PROJECT_NAME}LandingStack`, {
  ...baseProps,
});
landingStack.addDependency(dnsStack);

app.synth();
