import { ulid } from "ulid";
import { z } from "zod";

import { dateTransformer } from "@/utils/zod";

// The base schema enforces at minimum id as string, but should be extended in subclasses
export const baseSchema = z.object({
  id: z.string(),
  createdAt: dateTransformer().default(new Date()).optional(),
  updatedAt: dateTransformer().default(new Date()).optional(),
});

export const baseCreationSchema = baseSchema.omit({ id: true }).extend({
  id: z.string().optional(),
});
export type BaseCreationProps = z.infer<typeof baseCreationSchema>;

export abstract class BaseModel {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  constructor(props: BaseCreationProps) {
    if (!props.id) {
      props.id = ulid();
    }
    if (!props.createdAt) {
      props.createdAt = new Date();
    }
    if (!props.updatedAt) {
      props.updatedAt = new Date();
    }
    Object.assign(this, props);
  }

  abstract get PK(): string;
  abstract get SK(): string;

  /**
   * Converts the class to a validated object according to the schema.
   * Should be overridden by subclasses using the correct schema.
   */
  toObject() {
    return baseSchema.parse(this);
  }

  /**
   * Converts the model instance to a DynamoDB-compatible object.
   * Subclasses should extend this if additional fields are required.
   */
  toDynamoObject() {
    return {
      PK: this.PK,
      SK: this.SK,
      ...this.toObject(),
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }

  /**
   * Construct instance from DynamoDB object, using subclass constructor.
   * @param obj Partial instance - subclasses may override with more specific types.
   */
  static fromDynamoObject<T extends BaseModel>(
    this: new (props: any) => T,
    obj: any
  ): T {
    return new this(obj);
  }
}
