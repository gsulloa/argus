#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";

import { PROJECT_NAME } from "@/constants";

const baseProps = {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
};

const app = new cdk.App();

// TODO: ReleasesStack — migrate Cloudflare R2 artifact hosting to AWS (S3 + CloudFront)
//   new ReleasesStack(app, `${PROJECT_NAME}ReleasesStack`, { ...baseProps });
// TODO: FrontendStack — React + Vite landing page (S3 + CloudFront)
//   new FrontendStack(app, `${PROJECT_NAME}FrontendStack`, { ...baseProps });

// Reference to avoid noUnusedLocals (both vars are used in TODO comments above)
void PROJECT_NAME;
void baseProps;

app.synth();
