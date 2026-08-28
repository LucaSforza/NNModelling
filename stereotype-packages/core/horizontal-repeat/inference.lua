return function(context, parameters, services)
  local outputs = {}

  for branch = 1, parameters.times do
    local result = services.infer_subflow(context.inputs[1])

    if result.status == "error" then
      return {
        status = "error",
        message = "Horizontal Repeat branch " .. branch
          .. " failed: " .. result.message
      }
    end

    outputs[branch] = result.output
  end

  local joined = services.infer_stereotype(parameters.join, outputs)

  if joined.status == "error" then
    return {
      status = "error",
      message = "Horizontal Repeat join '" .. parameters.join.id
        .. "' failed: " .. joined.message
    }
  end

  return joined
end
