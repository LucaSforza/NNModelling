-- Model-owned layer scaffold: preserve the incoming tensor exactly.
return function(context, parameters, services)
  return { status = "success", output = context.inputs[1] }
end
