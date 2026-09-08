return function(context, parameters, services)
  local input = context.inputs[1]
  local rank, rank_error = tensor.rank(input)
  if rank_error then
    return { status = "error", message = rank_error }
  end
  if rank ~= 3 then
    return {
      status = "error",
      message = "TokenPool expects a rank-3 tensor [B, T, D], got rank " .. rank
    }
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
      message = "TokenPool expects a floating input dtype, got " .. input_dtype
    }
  end

  local batch, batch_error = tensor.dimension(input, 0)
  if batch_error then
    return { status = "error", message = batch_error }
  end
  local features, features_error = tensor.dimension(input, -1)
  if features_error then
    return { status = "error", message = features_error }
  end

  local output, output_error = tensor.create({ batch, features }, input_dtype)
  if output_error then
    return { status = "error", message = output_error }
  end
  return { status = "success", output = output }
end
