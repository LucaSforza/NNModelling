return function(context, parameters, services)
  local first = context.inputs[1]
  local first_dtype = tensor.dtype(first)
  local rank, rank_error = tensor.rank(first)

  if rank_error then
    return { status = "error", message = rank_error }
  end

  local first_size, dimension_error = tensor.dimension(
    first,
    parameters.dim
  )

  if dimension_error then
    return {
      status = "error",
      message = "Concat dimension " .. parameters.dim
        .. " is out of range for rank " .. rank
    }
  end

  if type(first_size) ~= "number" then
    return {
      status = "error",
      message = "Concat dimension " .. parameters.dim
        .. " must be numeric for every input"
    }
  end

  local concatenated_size = first_size

  for input_index = 2, #context.inputs do
    local input = context.inputs[input_index]
    local input_dtype = tensor.dtype(input)

    if input_dtype ~= first_dtype then
      return {
        status = "error",
        message = "Concat input " .. input_index
          .. " has dtype " .. input_dtype .. ", expected " .. first_dtype
      }
    end
    local input_rank, input_rank_error = tensor.rank(input)

    if input_rank_error then
      return { status = "error", message = input_rank_error }
    end

    if input_rank ~= rank then
      return {
        status = "error",
        message = "Concat input " .. input_index .. " has rank "
          .. input_rank .. ", expected " .. rank
      }
    end

    for current = 0, rank - 1 do
      local expected = tensor.dimension(first, current)
      local actual = tensor.dimension(input, current)
      local selected = current == parameters.dim
        or current == rank + parameters.dim

      if selected then
        if type(actual) ~= "number" then
          return {
            status = "error",
            message = "Concat dimension " .. parameters.dim
              .. " must be numeric for every input"
          }
        end

        concatenated_size = concatenated_size + actual
      elseif actual ~= expected then
        return {
          status = "error",
          message = "Concat input " .. input_index
            .. " is incompatible at dimension " .. current
        }
      end
    end
  end

  local output, output_error = tensor.with_dimension(
    first,
    parameters.dim,
    concatenated_size
  )

  if output_error then
    return { status = "error", message = output_error }
  end

  return { status = "success", output = output }
end
