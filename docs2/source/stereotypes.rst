Package definitions
===================

A package is identified by an exact id and version and contains declarative
metadata, an isolated Lua inference program and a PyTorch builder used only in
the worker container. The metadata declares package kind, parameters, view and
tensor contracts.

Kinds
-----

``input``
   Declares the top-level dataset input boundary.

``layer``
   Transforms one or more tensors in the prediction graph.

``loss``
   Computes an objective from prediction values and explicitly declared batch
   target bindings. It belongs to the objective program, not the prediction
   API.

``output``
   Marks the explicit prediction value exported by a trainable graph.

``join`` and ``subflow``
   Compose package graph values while preserving ordered handles and containment.

Package behavior is data-driven. The frontend never switches on package IDs to
infer types, and the backend never selects a loss by output shape, class name
or Python signature. Package builders execute only inside the least-privilege
worker container.
