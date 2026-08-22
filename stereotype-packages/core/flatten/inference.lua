return function(context, parameters)
  local output, output_error = tensor.flatten(
    context.inputs[1],
    parameters.start_dim,
    parameters.end_dim
  )
  if output_error then return { status = "error", message = output_error } end
  return { status = "success", output = output }
end
