#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";

import { PROJECT_NAME } from "@/constants";
import { DnsStack } from "@/lib/DnsStack/index";
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

// TODO: LandingStack — React + Vite landing page (S3 + CloudFront)
//   new LandingStack(app, `${PROJECT_NAME}LandingStack`, { ...baseProps });

app.synth();
