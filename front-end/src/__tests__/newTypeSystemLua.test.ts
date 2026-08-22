import { expect, test } from "vitest"

import { LuaInferenceRuntime } from "../type-system/lua/lua-inference-runtime"

const f32 = (shape: readonly (string | number)[]) => ({ shape, dtype: "float32" as const })

const identity = `
return function(context, parameters, services)
  return { status = "success", output = context.inputs[1] }
end
`

test("loads an isolated entrypoint and deep-copies its inputs", async () => {
  const runtime = await LuaInferenceRuntime.create(identity)
  const input = f32(["B", 4])

  expect(runtime.inferType({ inputs: [input] }, {})).toEqual({
    status: "success",
    output: input,
  })

  runtime.dispose()
  expect(() => runtime.inferType({ inputs: [input] }, {})).toThrow("disposed")
})

test("locks globals and resets mutable closure state", async () => {
  const first = await LuaInferenceRuntime.create(`
local count = 0
return function(context)
  count = count + 1
  return { status = "success", output = { shape = { count }, dtype = "float32" } }
end
`)
  const second = await LuaInferenceRuntime.create(identity)

  expect(first.inferType({ inputs: [f32([1])] }, {})).toEqual({
    status: "success",
    output: f32([1]),
  })
  expect(first.inferType({ inputs: [f32([1])] }, {})).toEqual({
    status: "success",
    output: f32([1]),
  })
  expect(second.inferType({ inputs: [f32([7])] }, {})).toEqual({
    status: "success",
    output: f32([7]),
  })

  const mutatesLibrary = await LuaInferenceRuntime.create(`
return function()
  table.count = (table.count or 0) + 1
  return { status = "success", output = { shape = { table.count }, dtype = "float32" } }
end
`)
  expect(mutatesLibrary.inferType({ inputs: [f32([1])] }, {})).toEqual({ status: "success", output: f32([1]) })
  expect(mutatesLibrary.inferType({ inputs: [f32([1])] }, {})).toEqual({ status: "success", output: f32([1]) })

  const forbidden = await LuaInferenceRuntime.create(`
return function()
  return { status = "success", output = { shape = { type(io), type(os), type(require), type(math.random) }, dtype = "float32" } }
end
`)
  expect(forbidden.inferType({ inputs: [f32([1])] }, {})).toEqual({
    status: "success",
    output: f32(["nil", "nil", "nil", "nil"]),
  })

  const writesGlobal = await LuaInferenceRuntime.create(`
return function()
  escaped = true
  return { status = "success", output = { shape = { 1 }, dtype = "float32" } }
end
`)
  expect(() => writesGlobal.inferType({ inputs: [f32([1])] }, {})).toThrow("global assignment")

  first.dispose()
  second.dispose()
  forbidden.dispose()
  writesGlobal.dispose()
  mutatesLibrary.dispose()
})

test("implements the tensor library with PyTorch dimension indexes", async () => {
  const runtime = await LuaInferenceRuntime.create(`
return function(context)
  local rank = tensor.rank(context.inputs[1])
  local last = tensor.dimension(context.inputs[1], -1)
  local output, message = tensor.with_dimension(context.inputs[1], 0, rank + last)
  if not output then return { status = "error", message = message } end
  if not tensor.equal(output, { shape = { rank + last, last }, dtype = "float32" }) then
    return { status = "error", message = "unexpected tensor" }
  end
  return { status = "success", output = output }
end
`)

  expect(runtime.inferType({ inputs: [f32([2, 3])] }, {})).toEqual({
    status: "success",
    output: f32([5, 3]),
  })

  runtime.dispose()
})

test("creates tensor types without an input tensor", async () => {
  const runtime = await LuaInferenceRuntime.create(`
return function(context, parameters)
  local output, message = tensor.create(parameters.shape, parameters.dtype)
  if not output then return { status = "error", message = message } end
  return { status = "success", output = output }
end
`)

  expect(runtime.inferType({ inputs: [] }, { shape: ["B", 3, 32, 32], dtype: "float16" })).toEqual({
    status: "success",
    output: { shape: ["B", 3, 32, 32], dtype: "float16" },
  })

  runtime.dispose()
})

test("flattens a tensor range through the package tensor library", async () => {
  const runtime = await LuaInferenceRuntime.create(`
return function(context)
  local output, message = tensor.flatten(context.inputs[1], 1, -1)
  if not output then return { status = "error", message = message } end
  return { status = "success", output = output }
end
`)

  expect(runtime.inferType({ inputs: [f32(["B", 64, 7, 7])] }, {})).toEqual({
    status: "success",
    output: f32(["B", 3136]),
  })
  runtime.dispose()
})

test("bridges granted capabilities without exposing host state", async () => {
  const runtime = await LuaInferenceRuntime.create(`
return function(context, parameters, services)
  local nested = services.infer_subflow(context.inputs[1])
  return services.infer_stereotype(parameters.reference, { nested.output })
end
`)

  expect(runtime.inferType(
    { inputs: [f32([1])] },
    {},
    {
      inferSubflow: (input) => ({ status: "success", output: { shape: [...input.shape, 2], dtype: input.dtype } }),
      inferStereotype: (_reference, inputs) => ({ status: "success", output: inputs[0]! }),
    },
  )).toEqual({ status: "success", output: f32([1, 2]) })

  runtime.dispose()
})

test("fails infinite loops and allocation pressure within configured limits", async () => {
  const looping = await LuaInferenceRuntime.create(`
return function()
  while true do end
end
`, { executionMs: 10 })
  expect(() => looping.inferType({ inputs: [f32([1])] }, {})).toThrow("timeout")
  looping.dispose()

  const allocating = await LuaInferenceRuntime.create(`
return function()
  local values = {}
  for i = 1, 1000000 do values[i] = string.rep("x", 128) end
  return { status = "success", output = { shape = { 1 }, dtype = "float32" } }
end
`, { memoryBytes: 128 * 1024 })
  expect(() => allocating.inferType({ inputs: [f32([1])] }, {})).toThrow()
  allocating.dispose()
})
