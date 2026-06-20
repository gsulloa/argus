import { Duration } from "aws-cdk-lib";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import {
  NodejsFunction,
  NodejsFunctionProps,
} from "aws-cdk-lib/aws-lambda-nodejs";
import { IBucket } from "aws-cdk-lib/aws-s3";
import { ITable } from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

import type { LambdaInvokeProps } from "@/constructs/LambdaInvoke";
import {
  LambdaScheduler,
  LambdaSchedulerParams,
} from "@/constructs/LambdaScheduler";

export class NodejsFunctionBuilder {
  postBuildSteps: ((lambda: NodejsFunction) => void)[] = [];
  constructor(
    private readonly scope: Construct,
    private readonly id: string,
    private props: NodejsFunctionProps
  ) {
    const defaultProps = {
      runtime: Runtime.NODEJS_22_X,
      memorySize: 512,
      timeout: Duration.seconds(30),
    };
    this.props = {
      ...defaultProps,
      ...props,
    };
  }
  addSchedule(params: Omit<LambdaSchedulerParams, "functionArn">): this {
    this.postBuildSteps.push((lambda) => {
      new LambdaScheduler(this.scope, `${this.id}Schedule`, {
        ...params,
        functionArn: lambda.functionArn,
      });
    });
    return this;
  }
  grantBucket(params: {
    bucket: IBucket;
    permissions: "read" | "write" | "readWrite";
    bucketNameEnv?: string;
  }) {
    this.props = {
      ...this.props,
      environment: {
        ...this.props.environment,
        [params.bucketNameEnv ?? "BUCKET_NAME"]: params.bucket.bucketName,
      },
    };
    this.postBuildSteps.push((lambda) => {
      switch (params.permissions) {
        case "read":
          params.bucket.grantRead(lambda);
          break;
        case "write":
          params.bucket.grantWrite(lambda);
          break;
        case "readWrite":
          params.bucket.grantReadWrite(lambda);
          break;
      }
    });
    return this;
  }

  grantDynamoDb(params: {
    table: ITable;
    permissions: "read" | "write" | "readWrite";
    tableNameEnv?: string;
  }): this {
    this.props = {
      ...this.props,
      environment: {
        ...this.props.environment,
        [params.tableNameEnv ?? "TABLE_NAME"]: params.table.tableName,
      },
    };
    this.postBuildSteps.push((lambda) => {
      switch (params.permissions) {
        case "read":
          params.table.grantReadData(lambda);
          break;
        case "write":
          params.table.grantWriteData(lambda);
          break;
        case "readWrite":
          params.table.grantReadWriteData(lambda);
          break;
      }
    });
    return this;
  }

  grantSes(): this {
    this.postBuildSteps.push((lambda) => {
      lambda.addToRolePolicy(
        new PolicyStatement({
          actions: ["ses:SendEmail", "ses:SendRawEmail"],
          resources: ["*"],
        })
      );
    });
    return this;
  }

  invokeOn(params: Omit<LambdaInvokeProps, "lambda">): this {
    const id = this.id;
    const scope = this.scope;
    this.postBuildSteps.push((lambda) => {
      const { LambdaInvoke } = require("@/constructs/LambdaInvoke");
      new LambdaInvoke(scope, `${id}Invoke`, { ...params, lambda });
    });
    return this;
  }

  build(): NodejsFunction {
    const lambda = new NodejsFunction(
      this.scope,
      `${this.id}Lambda`,
      this.props
    );
    this.postBuildSteps.forEach((step) => step(lambda));
    return lambda;
  }
}
