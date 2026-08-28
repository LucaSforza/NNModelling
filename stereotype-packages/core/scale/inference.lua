return function(context, parameters, services)
  if type(parameters.factor) ~= "number" then
    return { status = "error", message = "Scale factor must be a number" }
  end
  return { status = "success", output = context.inputs[1] }
end
