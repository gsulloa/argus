#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";

import { PROJECT_NAME } from "@/constants";
import { ReleasesStack } from "@/lib/ReleasesStack/index";

const baseProps = {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
};

const app = new cdk.App();

new ReleasesStack(app, `${PROJECT_NAME}ReleasesStack`, { ...baseProps });

// TODO: LandingStack — React + Vite landing page (S3 + CloudFront)
//   new LandingStack(app, `${PROJECT_NAME}LandingStack`, { ...baseProps });

app.synth();
