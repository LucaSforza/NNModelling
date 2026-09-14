Training user guide
===================

1. Select the built-in or project dataset for training and review its named
   ``inputs`` and ``targets`` slots. Dataset selection supplies the boundary
   shapes and dtypes needed for complete Input-dependent inference.
2. Build the package graph. Use one or more top-level ``Input`` nodes whose
   ``params.binding`` values match the dataset's input slot names. Add an
   explicit ``Output`` for prediction and connect each objective package to the
   prediction value it consumes. A loss package's declared target bindings
   must match the selected dataset's target slots.
3. Configure the settings declared by the dataset (including batch size,
   workers and split), then choose the seed, optimizer, trainer, accelerator,
   early stopping and W&B mode. Resolve any type or dataset diagnostics before
   submission.
4. Submit the job. The browser uploads an authenticated immutable package
   bundle and receives a job identifier.
5. Follow status, logs and events in the Training sidebar.
6. On success, download the portable Python wheel. It contains the package
   graph, package resources, input adapter metadata and ``safetensors`` weights.

The wheel's prediction API does not need targets. Training targets are supplied
only by the selected dataset adapter to the objective program.

For a model with multiple named inputs, use ``predict_tensor`` with a mapping
from each input binding name to its tensor. The convenience ``predict`` method
is for models with one input.

For security, package code runs only in the worker container. The API process
does not import package builders, and no free-form configuration overrides are
accepted.
