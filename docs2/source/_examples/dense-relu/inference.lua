return function(context, parameters, services)
  local input = context.inputs[1]
  local dtype, dtype_error = tensor.dtype(input)
  if dtype_error then
    return { status = "error", message = dtype_error }
  end

  if dtype ~= "float32" then
    return {
      status = "error",
      message = "Dense ReLU expects float32, got " .. dtype
    }
  end

  local features, dimension_error = tensor.dimension(input, -1)
  if dimension_error then
    return { status = "error", message = dimension_error }
  end

  if features ~= parameters.in_features then
    return {
      status = "error",
      message = "Dense ReLU expected " .. parameters.in_features
        .. " input features, got " .. tostring(features)
    }
  end

  -- Linear changes only the last axis; ReLU preserves shape and dtype.
  local output, output_error = tensor.with_dimension(
    input, -1, parameters.out_features
  )
  if output_error then
    return { status = "error", message = output_error }
  end

  return { status = "success", output = output }
end
