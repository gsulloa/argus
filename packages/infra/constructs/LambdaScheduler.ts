import {
  Effect,
  Policy,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { CfnSchedule } from "aws-cdk-lib/aws-scheduler";
import { Construct } from "constructs";

export interface LambdaSchedulerParams {
  functionArn: string;
  cron: string;
  eventBody?: Record<string, unknown>;
  enabled?: boolean;
}
export class LambdaScheduler extends Construct {
  constructor(construct: Construct, id: string, params: LambdaSchedulerParams) {
    super(construct, id);
    if (!params.enabled && !/true/i.exec(process.env.SCHEDULERS ?? "")) return;
    const schedulerRole = new Role(construct, `${id}SchedulerRole`, {
      assumedBy: new ServicePrincipal("scheduler.amazonaws.com"),
    });
    const invokeLambdaPolicy = new Policy(
      construct,
      `${id}InvokeLambdaPolicy`,
      {
        document: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ["lambda:InvokeFunction"],
              resources: [params.functionArn],
              effect: Effect.ALLOW,
            }),
          ],
        }),
      }
    );
    schedulerRole.attachInlinePolicy(invokeLambdaPolicy);
    new CfnSchedule(construct, `${id}Schedule`, {
      target: {
        arn: params.functionArn,
        roleArn: schedulerRole.roleArn,
        input: params.eventBody ? JSON.stringify(params.eventBody) : undefined,
      },
      flexibleTimeWindow: { mode: "OFF" },
      scheduleExpression: params.cron,
      scheduleExpressionTimezone: "America/Santiago",
    });
  }
}
