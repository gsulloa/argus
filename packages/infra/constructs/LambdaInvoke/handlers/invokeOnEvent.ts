import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { CdkCustomResourceHandler } from "aws-lambda";

import { EventType } from "../LambdaInvoke";

const client = new LambdaClient({});

export const handler: CdkCustomResourceHandler = async (event) => {
  console.log({ msg: "event", ...event });
  const { targetFn: fnName, eventTypes, payload } = event.ResourceProperties;

  const invoke = async () => {
    const res = await client.send(
      new InvokeCommand({
        FunctionName: fnName,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify(payload)),
      })
    );
    console.log({ msg: "Lambda invoked", res });
  };
  if (event.RequestType === "Create" && eventTypes.includes(EventType.CREATE)) {
    console.log({ msg: "Invoking lambda on create event" });
    await invoke();
  }
  if (event.RequestType === "Update" && eventTypes.includes(EventType.UPDATE)) {
    console.log({ msg: "Invoking lambda on update event" });
    await invoke();
  }
  if (event.RequestType === "Delete" && eventTypes.includes(EventType.DELETE)) {
    console.log({ msg: "Invoking lambda on delete event" });
    await invoke();
  }
  return { PhysicalResourceId: `Invoke-${fnName}`, Data: { invoked: true } };
};
