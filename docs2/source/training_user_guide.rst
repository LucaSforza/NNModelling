Training user guide
===================

1. Build a type-valid package graph in the browser. Include a package output
   node for prediction and connect each objective package to the prediction
   value it consumes.
2. Select a registered dataset and configure batch size, workers, split, seed,
   optimizer, trainer, accelerator, early stopping and W&B mode.
3. Submit the job. The browser uploads an authenticated immutable package
   bundle and receives a job identifier.
4. Follow status, logs and events in the Training sidebar.
5. On success, download the portable Python wheel. It contains the package
   graph, package resources, input adapter metadata and ``safetensors`` weights.

The wheel's prediction API does not need targets. Training targets are supplied
only by the selected dataset adapter to the objective program.

For security, package code runs only in the worker container. The API process
does not import package builders, and no free-form configuration overrides are
accepted.
