return function(context, parameters, services)
  local input = context.inputs[1]
  local input_dtype, dtype_error = tensor.dtype(input)

  if dtype_error then
    return { status = "error", message = dtype_error }
  end

  if input_dtype ~= parameters.dtype then
    return {
      status = "error",
      message = "Linear expects dtype " .. parameters.dtype
        .. ", got " .. input_dtype
    }
  end

  local features, dimension_error = tensor.dimension(input, -1)

  if dimension_error then
    return { status = "error", message = dimension_error }
  end

  if features ~= parameters.in_features then
    return {
      status = "error",
      message = "Expected " .. parameters.in_features
        .. " input features, got " .. tostring(features)
    }
  end

  local output, output_error = tensor.with_dimension(
    input,
    -1,
    parameters.out_features
  )

  if output_error then
    return { status = "error", message = output_error }
  end

  return { status = "success", output = output }
end
