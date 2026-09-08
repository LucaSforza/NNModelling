return function(context, parameters, services)
  local input = context.inputs[1]
  local rank, rank_error = tensor.rank(input)

  if rank_error then
    return { status = "error", message = rank_error }
  end

  if rank < 1 then
    return { status = "error", message = "Reparameterize expects packed Gaussian parameters with rank at least 1" }
  end

  local input_dtype, dtype_error = tensor.dtype(input)
  if dtype_error then
    return { status = "error", message = dtype_error }
  end
  if input_dtype ~= "float16"
      and input_dtype ~= "bfloat16"
      and input_dtype ~= "float32"
      and input_dtype ~= "float64" then
    return {
      status = "error",
      message = "Reparameterize expects a floating input dtype, got " .. input_dtype
    }
  end

  local packed_size, dimension_error = tensor.dimension(input, -1)
  if dimension_error then
    return { status = "error", message = dimension_error }
  end
  if type(packed_size) ~= "number" then
    return { status = "error", message = "Reparameterize requires a numeric packed last dimension" }
  end
  if packed_size % 2 ~= 0 then
    return { status = "error", message = "Reparameterize requires an even packed last dimension" }
  end

  local output, output_error = tensor.with_dimension(input, -1, packed_size / 2)
  if output_error then
    return { status = "error", message = output_error }
  end
  return { status = "success", output = output }
end
