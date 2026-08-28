return function(context, parameters, services)
  local first = context.inputs[1]

  for index = 2, #context.inputs do
    local equal, comparison_error = tensor.equal(
      first,
      context.inputs[index]
    )

    if comparison_error then
      return { status = "error", message = comparison_error }
    end

    if not equal then
      return {
        status = "error",
        message = "Add input " .. index .. " is incompatible with input 1"
      }
    end
  end

  return { status = "success", output = first }
end
