return function(context, parameters, services)
  if #context.inputs < 2 then
    return {
      status = "error",
      message = "MatMul expects at least 2 inputs"
    }
  end

  local output = context.inputs[1]
  local output_rank, output_rank_error = tensor.rank(output)

  if output_rank_error then
    return { status = "error", message = output_rank_error }
  end
  if output_rank ~= 2 then
    return {
      status = "error",
      message = "MatMul input 1 must have rank 2, got " .. output_rank
    }
  end

  local expected_dtype = tensor.dtype(output)

  for input_index = 2, #context.inputs do
    local input = context.inputs[input_index]
    local input_rank, input_rank_error = tensor.rank(input)

    if input_rank_error then
      return { status = "error", message = input_rank_error }
    end
    if input_rank ~= 2 then
      return {
        status = "error",
        message = "MatMul input " .. input_index
          .. " must have rank 2, got " .. input_rank
      }
    end

    local input_dtype = tensor.dtype(input)
    if input_dtype ~= expected_dtype then
      return {
        status = "error",
        message = "MatMul input " .. input_index .. " has dtype " .. input_dtype
          .. ", expected " .. expected_dtype
      }
    end

    local output_inner, output_dimension_error = tensor.dimension(output, -1)
    local input_inner, input_dimension_error = tensor.dimension(input, 0)
    if output_dimension_error then
      return { status = "error", message = output_dimension_error }
    end
    if input_dimension_error then
      return { status = "error", message = input_dimension_error }
    end
    if output_inner ~= input_inner then
      return {
        status = "error",
        message = "MatMul inner dimensions are incompatible: input "
          .. (input_index - 1) .. " has " .. tostring(output_inner)
          .. ", input " .. input_index .. " has " .. tostring(input_inner)
      }
    end

    local input_output_size, output_size_error = tensor.dimension(input, -1)
    if output_size_error then
      return { status = "error", message = output_size_error }
    end
    local next_output, next_output_error = tensor.with_dimension(
      output,
      -1,
      input_output_size
    )
    if next_output_error then
      return { status = "error", message = next_output_error }
    end
    output = next_output
  end

  return { status = "success", output = output }
end
