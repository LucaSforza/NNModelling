# Core product-mode packages

The ResNet-oriented packages in this directory (`conv2d`, `batch-norm2d`,
`relu`, `max-pool2d`, `adaptive-avg-pool2d`, and `flatten`) are NNModelling
product-mode packages. Their Cordis/Lua contracts were implemented for the
frontend host and are not copied from the stereotype-lab oracle. They expose
only semantic shape/dtype inference; backend code generation is intentionally
outside this package slice.
