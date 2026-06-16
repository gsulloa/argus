import { CustomResource, Duration } from "aws-cdk-lib";
import { Function } from "aws-cdk-lib/aws-lambda";
import { Provider } from "aws-cdk-lib/custom-resources";
import { Construct, IDependable } from "constructs";
import path from "path";

import { NodejsFunctionBuilder } from "@/builders/NodejsFunctionBuilder";

export enum EventType {
  CREATE = "CREATE",
  UPDATE = "UPDATE",
  DELETE = "DELETE",
}
export interface LambdaInvokeProps {
  lambda: Function;
  dependencies: IDependable[];
  outputPaths?: string[];
  payload?: Record<string, unknown>;
  on: EventType[];
}

export class LambdaInvoke extends Construct {
  constructor(scope: Construct, id: string, props: LambdaInvokeProps) {
    super(scope, id);

    const onEvent = new NodejsFunctionBuilder(this, "InvokeOnEvent", {
      entry: path.resolve(__dirname, "./handlers/invokeOnEvent.ts"),
      timeout: Duration.minutes(2),
    }).build();
    props.lambda.grantInvoke(onEvent);

    const provider = new Provider(this, `Provider`, {
      onEventHandler: onEvent,
    });

    const customResource = new CustomResource(this, `Resource`, {
      serviceToken: provider.serviceToken,
      properties: {
        targetFn: props.lambda.functionName,
        eventTypes: props.on,
        payload: props.payload ?? {},
      },
    });

    customResource.node.addDependency(props.lambda, ...props.dependencies);
  }
}
