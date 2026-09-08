return function(context, parameters, services)
  local input = context.inputs[1]
  local rank, rank_error = tensor.rank(input)

  if rank_error then
    return { status = "error", message = rank_error }
  end
  local dim0 = parameters.dim0 or -2
  local dim1 = parameters.dim1 or -1
  if rank < 2 then
    return {
      status = "error",
      message = "Transpose expects a tensor of rank at least 2, got " .. rank
    }
  end

  local first, first_error = tensor.dimension(input, dim0)
  if first_error then
    return { status = "error", message = "Transpose dim0: " .. first_error }
  end
  local second, second_error = tensor.dimension(input, dim1)
  if second_error then
    return { status = "error", message = "Transpose dim1: " .. second_error }
  end

  local output, output_error = tensor.with_dimension(input, dim0, second)
  if output_error then return { status = "error", message = output_error } end
  output, output_error = tensor.with_dimension(output, dim1, first)
  if output_error then return { status = "error", message = output_error } end

  return { status = "success", output = output }
end
