Package definitions
===================

A package is identified by an exact id and version. Its ``stereotype.json``
declares the package kind, parameters and presentation metadata; its
``inference.lua`` owns frontend tensor inference; and its ``pytorch.py`` builder
runs only in the backend worker container. The frontend does not infer tensor
semantics from a JSON ``type_signature`` or package-ID switch.

Kinds
-----

``input``
   Declares a named top-level dataset input boundary. Its ``params.binding``
   selects a slot from the active dataset; the dataset provides shape and dtype.

``layer``
   Transforms one graph tensor. Use a ``join`` package to combine multiple
   graph inputs.

``loss``
   Computes an objective from prediction values and explicitly declared batch
   target bindings. Targets are supplied separately to the training objective;
   they are not ordinary graph edges or prediction inputs.

``output``
   Marks the explicit prediction value exported by a trainable graph.

``join`` and ``subflow``
   Compose package graph values while preserving ordered handles and containment.

The frontend type system executes the package's Lua inference rule. Successful
results contain a tensor shape and dtype; missing dataset information or
required parameters can leave a region unresolved without manufacturing an
``unknown`` tensor. Expected semantic errors and package-runtime faults remain
distinct.

Package behavior is data-driven. The frontend never switches on package IDs to
infer types, and the backend never selects a loss by output shape, class name
or Python signature. Package builders execute only inside the least-privilege
worker container.
