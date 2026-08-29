return function(context, parameters, services)
  local input = context.inputs[1]
  return { status = "success", output = input }
end
