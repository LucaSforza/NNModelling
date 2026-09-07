local function error_result(message)
  return { status = "error", message = message }
end

local function read_dimension(input, dimension)
  local value, error = tensor.dimension(input, dimension)
  if error then return nil, error end
  return value, nil
end

local function broadcast_dimension(left, right)
  if left == right then return left end
  if type(left) == "number" and left == 1 then return right end
  if type(right) == "number" and right == 1 then return left end
  return nil
end

local function batch_shape(left, right, left_index, right_index)
  local result = {}
  local count = math.max(#left, #right)

  for aligned = 1, count do
    local left_position = aligned - (count - #left)
    local right_position = aligned - (count - #right)
    local left_dimension = left_position > 0 and left[left_position] or 1
    local right_dimension = right_position > 0 and right[right_position] or 1
    local output_dimension = broadcast_dimension(left_dimension, right_dimension)

    if output_dimension == nil then
      return nil, "MatMul batch dimensions are incompatible: input "
        .. left_index .. " has " .. tostring(left_dimension)
        .. ", input " .. right_index .. " has " .. tostring(right_dimension)
        .. " at aligned batch dimension " .. aligned
    end
    result[#result + 1] = output_dimension
  end

  return result, nil
end

local function matrix_multiply(left, right, right_index)
  local left_rank, left_rank_error = tensor.rank(left)
  if left_rank_error then return nil, left_rank_error end
  local right_rank, right_rank_error = tensor.rank(right)
  if right_rank_error then return nil, right_rank_error end

  if left_rank < 1 then
    return nil, "MatMul input " .. (right_index - 1)
      .. " must have rank at least 1, got " .. left_rank
  end
  if right_rank < 1 then
    return nil, "MatMul input " .. right_index
      .. " must have rank at least 1, got " .. right_rank
  end

  local dtype = tensor.dtype(left)
  local right_dtype = tensor.dtype(right)
  if dtype ~= right_dtype then
    return nil, "MatMul input " .. right_index .. " has dtype " .. right_dtype
      .. ", expected " .. dtype
  end

  local left_inner, left_dimension_error = read_dimension(left, -1)
  if left_dimension_error then return nil, left_dimension_error end
  local right_inner_dimension = right_rank == 1 and -1 or -2
  local right_inner, right_dimension_error = read_dimension(right, right_inner_dimension)
  if right_dimension_error then return nil, right_dimension_error end

  if left_inner ~= right_inner then
    return nil, "MatMul inner dimensions are incompatible: input "
      .. (right_index - 1) .. " has " .. tostring(left_inner)
      .. ", input " .. right_index .. " has " .. tostring(right_inner)
  end

  local left_batch = {}
  if left_rank >= 2 then
    for dimension = 1, left_rank - 2 do
      left_batch[#left_batch + 1] = left.shape[dimension]
    end
  end

  local right_batch = {}
  if right_rank >= 2 then
    for dimension = 1, right_rank - 2 do
      right_batch[#right_batch + 1] = right.shape[dimension]
    end
  end

  local output_batch, batch_error = batch_shape(
    left_batch,
    right_batch,
    right_index - 1,
    right_index
  )
  if batch_error then return nil, batch_error end

  local output_shape = output_batch
  if left_rank >= 2 then
    local rows, rows_error = read_dimension(left, -2)
    if rows_error then return nil, rows_error end
    output_shape[#output_shape + 1] = rows
  end
  if right_rank >= 2 then
    local columns, columns_error = read_dimension(right, -1)
    if columns_error then return nil, columns_error end
    output_shape[#output_shape + 1] = columns
  end

  local output, output_error = tensor.create(output_shape, dtype)
  if output_error then return nil, output_error end
  return output, nil
end

return function(context, parameters, services)
  if #context.inputs < 2 then
    return error_result("MatMul expects at least 2 inputs")
  end

  local output = context.inputs[1]
  for input_index = 2, #context.inputs do
    local next_output, output_error = matrix_multiply(
      output,
      context.inputs[input_index],
      input_index
    )
    if output_error then return error_result(output_error) end
    output = next_output
  end

  return { status = "success", output = output }
end
