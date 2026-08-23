return function(context, parameters, services)
  return services.infer_subflow(context.inputs[1])
end
