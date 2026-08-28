return function(context, parameters)
  local input = context.inputs[1]
  local rank, rank_error = tensor.rank(input)
  if rank_error then return { status = "error", message = rank_error } end
  if rank ~= 4 then
    return { status = "error", message = "AdaptiveAvgPool2d expects an NCHW rank-4 tensor" }
  end

  local output, output_error = tensor.with_dimension(input, 2, parameters.output_size)
  if output_error then return { status = "error", message = output_error } end
  output, output_error = tensor.with_dimension(output, 3, parameters.output_size)
  if output_error then return { status = "error", message = output_error } end
  return { status = "success", output = output }
end
