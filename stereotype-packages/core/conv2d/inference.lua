return function(context, parameters)
  local input = context.inputs[1]
  local rank, rank_error = tensor.rank(input)
  if rank_error then return { status = "error", message = rank_error } end
  if rank ~= 4 then
    return { status = "error", message = "Conv2d expects an NCHW rank-4 tensor" }
  end

  local channels, channel_error = tensor.dimension(input, 1)
  if channel_error then return { status = "error", message = channel_error } end
  if type(channels) == "number" and channels ~= parameters.in_channels then
    return {
      status = "error",
      message = "Conv2d expected " .. parameters.in_channels
        .. " input channels, got " .. channels,
    }
  end
  if parameters.in_channels % parameters.groups ~= 0
      or parameters.out_channels % parameters.groups ~= 0 then
    return { status = "error", message = "Conv2d channels must be divisible by groups" }
  end

  local height, height_error = tensor.dimension(input, 2)
  local width, width_error = tensor.dimension(input, 3)
  if height_error then return { status = "error", message = height_error } end
  if width_error then return { status = "error", message = width_error } end
  if type(height) ~= "number" or type(width) ~= "number" then
    return { status = "error", message = "Conv2d requires numeric spatial dimensions" }
  end

  local function output_size(size)
    return math.floor((size + 2 * parameters.padding
      - parameters.dilation * (parameters.kernel_size - 1) - 1)
      / parameters.stride + 1)
  end
  local output_height = output_size(height)
  local output_width = output_size(width)
  if output_height < 1 or output_width < 1 then
    return { status = "error", message = "Conv2d kernel does not fit the input" }
  end

  local output, output_error = tensor.with_dimension(input, 1, parameters.out_channels)
  if output_error then return { status = "error", message = output_error } end
  output, output_error = tensor.with_dimension(output, 2, output_height)
  if output_error then return { status = "error", message = output_error } end
  output, output_error = tensor.with_dimension(output, 3, output_width)
  if output_error then return { status = "error", message = output_error } end
  return { status = "success", output = output }
end
