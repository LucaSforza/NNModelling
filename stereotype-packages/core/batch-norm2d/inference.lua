return function(context, parameters)
  local input = context.inputs[1]
  local rank, rank_error = tensor.rank(input)
  if rank_error then return { status = "error", message = rank_error } end
  if rank ~= 4 then
    return { status = "error", message = "BatchNorm2d expects a rank-4 tensor" }
  end

  local channels, channel_error = tensor.dimension(input, 1)
  if channel_error then return { status = "error", message = channel_error } end
  if type(channels) == "number" and channels ~= parameters.num_features then
    return {
      status = "error",
      message = "BatchNorm2d expected " .. parameters.num_features
        .. " channels, got " .. channels,
    }
  end
  return { status = "success", output = input }
end
