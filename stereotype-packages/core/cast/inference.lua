return function(context, parameters, services)
  local input = context.inputs[1]
  local output, output_error = tensor.with_dtype(input, parameters.dtype)

  if output_error then
    return { status = "error", message = output_error }
  end

  return {
    status = "success",
    output = output,
  }
end
