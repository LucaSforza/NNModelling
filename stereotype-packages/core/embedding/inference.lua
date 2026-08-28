return function(context, parameters, services)
  local input = context.inputs[1]
  local input_dtype, dtype_error = tensor.dtype(input)

  if dtype_error then
    return { status = "error", message = dtype_error }
  end

  if input_dtype ~= parameters.input_dtype then
    return {
      status = "error",
      message = "Embedding expects input dtype " .. parameters.input_dtype
        .. ", got " .. input_dtype,
    }
  end

  local output, output_error = tensor.append_dimension(
    input,
    parameters.embedding_dim
  )

  if output_error then
    return { status = "error", message = output_error }
  end

  output = tensor.with_dtype(output, parameters.dtype)

  return {
    status = "success",
    output = output,
  }
end
