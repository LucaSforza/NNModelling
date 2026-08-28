return function(context, parameters, services)
  local output = context.inputs[1]

  for iteration = 1, parameters.times do
    local result = services.infer_subflow(output)

    if result.status == "error" then
      return {
        status = "error",
        message = "Repeat iteration " .. iteration
          .. " failed: " .. result.message
      }
    end

    output = result.output
  end

  return { status = "success", output = output }
end
