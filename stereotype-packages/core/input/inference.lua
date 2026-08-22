return function(context, parameters, services)
  local output, message = tensor.create(parameters.shape, parameters.dtype)

  if message then
    return { status = "error", message = message }
  end

  return { status = "success", output = output }
end
