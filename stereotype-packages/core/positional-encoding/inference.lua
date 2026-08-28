return function(context, parameters)
  local input = context.inputs[1]
  local rank, rank_error = tensor.rank(input)

  if rank_error then
    return { status = "error", message = rank_error }
  end

  if rank ~= 3 then
    return {
      status = "error",
      message = "Positional Encoding expects a rank-3 input [B, L, D], got rank " .. rank
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
      message = "Positional Encoding expects a floating input dtype, got " .. input_dtype
    }
  end

  local embedding_dim, dimension_error = tensor.dimension(input, -1)
  if dimension_error then
    return { status = "error", message = dimension_error }
  end

  local d_model = parameters.d_model or 512
  if type(embedding_dim) == "number" and embedding_dim ~= d_model then
    return {
      status = "error",
      message = "Positional Encoding expects embedding dimension " .. d_model
        .. ", got " .. embedding_dim
    }
  end

  return { status = "success", output = input }
end
