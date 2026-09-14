import { z } from "zod"
import type { ServerContext } from "../server.js"

const packageKind = z.enum(["input", "layer", "loss", "join", "subflow", "output"])
const dtype = z.enum([
  "float16", "bfloat16", "float32", "float64",
  "int8", "uint8", "int16", "int32", "int64", "bool",
])
const dimension = z.union([z.string(), z.number().finite()])
const jsonValue: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(jsonValue),
  z.record(z.string(), jsonValue),
]))

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

const listItemDefinition = z.discriminatedUnion("type", [
  z.object({ type: z.literal("integer"), minimum: z.number().optional(), maximum: z.number().optional(), default: z.number().int().optional() }).strict(),
  z.object({ type: z.literal("number"), minimum: z.number().optional(), maximum: z.number().optional(), default: z.number().optional() }).strict(),
  z.object({ type: z.literal("boolean"), default: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("string"), choices: z.array(z.string()).optional(), default: z.string().optional() }).strict(),
])

const parameterDefinition = z.discriminatedUnion("type", [
  z.object({ type: z.literal("integer"), minimum: z.number().optional(), maximum: z.number().optional(), default: z.number().int().optional(), position: z.enum(["top", "bottom"]) }).strict(),
  z.object({ type: z.literal("number"), minimum: z.number().optional(), maximum: z.number().optional(), default: z.number().optional(), position: z.enum(["top", "bottom"]) }).strict(),
  z.object({ type: z.literal("boolean"), default: z.boolean().optional(), position: z.enum(["top", "bottom"]) }).strict(),
  z.object({ type: z.literal("string"), choices: z.array(z.string()).optional(), default: z.string().optional(), position: z.enum(["top", "bottom"]) }).strict(),
  z.object({ type: z.literal("dtype"), choices: z.array(dtype), default: dtype.optional(), position: z.enum(["top", "bottom"]) }).strict(),
  z.object({ type: z.literal("shape"), default: z.array(dimension).optional(), position: z.enum(["top", "bottom"]) }).strict(),
  z.object({
    type: z.literal("list"),
    items: listItemDefinition,
    minItems: z.number().optional(),
    maxItems: z.number().optional(),
    default: z.array(jsonValue).optional(),
    position: z.enum(["top", "bottom"]),
  }).strict(),
  z.object({
    type: z.literal("stereotype"),
    kind: packageKind,
    default: z.object({
      id: z.string().min(1),
      version: z.string().min(1),
      parameters: z.record(z.string(), jsonValue),
    }).strict().optional(),
    position: z.enum(["top", "bottom"]),
  }).strict(),
])

const stereotypeAuthoringRequest = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  directory: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  kind: packageKind,
  view: z.object({
    color: z.string(),
    width: z.number(),
    height: z.number(),
  }).strict(),
  dependencies: z.record(z.string(), z.string()).optional(),
  parameters: z.array(z.object({
    name: z.string().min(1),
    definition: parameterDefinition,
  }).strict()),
  objective: z.object({
    externalInputs: z.array(z.object({
      name: z.string(),
      source: z.string(),
      transform: z.enum(["flatten_batch"]).optional(),
    }).strict()),
  }).strict().optional(),
}).strict()

const datasetParameter = z.discriminatedUnion("type", [
  z.object({ name: z.string(), type: z.literal("string"), required: z.boolean(), default: z.string().optional() }).strict(),
  z.object({ name: z.string(), type: z.literal("integer"), required: z.boolean(), default: z.number().int().optional() }).strict(),
  z.object({ name: z.string(), type: z.literal("number"), required: z.boolean(), default: z.number().optional() }).strict(),
  z.object({ name: z.string(), type: z.literal("boolean"), required: z.boolean(), default: z.boolean().optional() }).strict(),
])

const datasetSlot = z.object({
  name: z.string(),
  shape: z.array(dimension),
  dtype,
}).strict()

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

const isCanonicalBase64 = (value: string): boolean => {
  if (!BASE64.test(value)) return false
  return Buffer.from(value, "base64").toString("base64") === value
}

const datasetAuthoringRequest = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  directory: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  parameters: z.array(datasetParameter),
  inputs: z.array(datasetSlot),
  targets: z.array(datasetSlot),
  classes: z.object({
    count: z.number().int(),
    names: z.array(z.string()).optional(),
  }).strict().optional(),
  dataFiles: z.array(z.object({
    path: z.string().min(1),
    dataBase64: z.string().regex(BASE64, "must use standard base64").refine(isCanonicalBase64, "must be canonical standard base64"),
  }).strict()).optional(),
}).strict()

const resourceIdentity = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  path: z.string().min(1),
}).strict()

/** Create a project-owned stereotype through the selected browser's authoring coordinator. */
export const create_stereotype = {
  schema: stereotypeAuthoringRequest,
  async handler(ctx: ServerContext, input: z.infer<typeof stereotypeAuthoringRequest>) {
    return ctx.browser.call("create_stereotype", input)
  },
}

/** Delete exactly one project-owned stereotype; ownership and eligibility stay browser-owned. */
export const delete_stereotype = {
  schema: resourceIdentity,
  async handler(ctx: ServerContext, input: z.infer<typeof resourceIdentity>) {
    return ctx.browser.call("delete_stereotype", input)
  },
}

/** Create a project-owned dataset; optional file bytes cross JSON as canonical base64. */
export const create_dataset = {
  schema: datasetAuthoringRequest,
  async handler(ctx: ServerContext, input: z.infer<typeof datasetAuthoringRequest>) {
    return ctx.browser.call("create_dataset", input)
  },
}

/** Delete exactly one project-owned dataset; backend archives and jobs are untouched by this proxy. */
export const delete_dataset = {
  schema: resourceIdentity,
  async handler(ctx: ServerContext, input: z.infer<typeof resourceIdentity>) {
    return ctx.browser.call("delete_dataset", input)
  },
}
