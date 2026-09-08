return function(context, parameters)
  local input = context.inputs[1]
  local features, dimension_error = tensor.dimension(input, -1)
  if dimension_error then return { status = "error", message = dimension_error } end

  if type(features) == "number" and features ~= parameters.normalized_shape then
    return {
      status = "error",
      message = "LayerNorm expected last dimension " .. parameters.normalized_shape
        .. ", got " .. features,
    }
  end

  return { status = "success", output = input }
end
