return function(context, parameters)
  local input = context.inputs[1]
  local rank, rank_error = tensor.rank(input)
  if rank_error then return { status = "error", message = rank_error } end

  local _, dimension_error = tensor.dimension(input, parameters.dim)
  if dimension_error then
    return {
      status = "error",
      message = "Softmax dimension " .. parameters.dim
        .. " is out of range for rank " .. rank,
    }
  end

  return { status = "success", output = input }
end
