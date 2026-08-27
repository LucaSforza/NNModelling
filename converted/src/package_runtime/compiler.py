"""Compile a validated package graph into a PyTorch module."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, NamedTuple

import torch

from stereotype_runtime import pytorch as stereotype_pytorch
from stereotype_runtime.pytorch import BuildContext, StereotypeReference

from .loader import PackageValidationError, ValidatedPackage, load_builder, validate_bundle


def compile_package_graph(bundle: Mapping[str, Any]) -> "CompiledPrograms":
    """Compile a package graph into shared prediction/objective programs."""

    packages = _package_catalog(bundle)
    graph = bundle.get("graph")
    if not isinstance(graph, Mapping):
        raise PackageValidationError("package requires a graph")
    return _compile_programs(graph, packages, "root")


def adapter_descriptors(bundle: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Validate and return the explicitly selected wheel adapter metadata."""

    return [dict(item) for item in _selected_adapter_descriptors(bundle.get("graph"), _package_catalog(bundle))]


def compile_package_programs(bundle: Mapping[str, Any]) -> "CompiledPrograms":
    """Compile the package graph and expose its two explicit execution views."""

    return compile_package_graph(bundle)


def _package_catalog(bundle: Mapping[str, Any]) -> dict[tuple[str, str], ValidatedPackage]:
    raw_packages = bundle.get("packages")
    if not isinstance(raw_packages, list) or not raw_packages:
        raise PackageValidationError("package requires a non-empty packages list")
    catalog: dict[tuple[str, str], ValidatedPackage] = {}
    for raw in raw_packages:
        if not isinstance(raw, Mapping):
            raise PackageValidationError("package entries must be objects")
        package = validate_bundle(raw)
        key = (package.package_id, package.version)
        if key in catalog:
            raise PackageValidationError(f"duplicate package {package.package_id}@{package.version}")
        catalog[key] = package
    for package in catalog.values():
        for dependency, requirement in package.dependencies.items():
            if (dependency, requirement) not in catalog and not any(
                key[0] == dependency and _version_matches(key[1], requirement) for key in catalog
            ):
                raise PackageValidationError(f"missing dependency {dependency}@{requirement}")
    return catalog


def _compile_programs(graph: Mapping[str, Any], catalog: dict[tuple[str, str], ValidatedPackage], scope: str) -> "CompiledPrograms":
    graph = _normalize_graph(graph, scope, catalog)
    raw_nodes = graph.get("nodes")
    raw_edges = graph.get("edges")
    if not isinstance(raw_nodes, list) or not isinstance(raw_edges, list) or not raw_nodes:
        raise PackageValidationError(f"{scope} graph requires nodes and edges")
    nodes = {node.get("id"): node for node in raw_nodes if isinstance(node, Mapping) and isinstance(node.get("id"), str)}
    if len(nodes) != len(raw_nodes):
        raise PackageValidationError(f"{scope} graph contains invalid or duplicate node ids")
    edges = _validate_edges(raw_edges, nodes, scope)
    _ensure_acyclic(nodes, edges, scope)
    roots = [node_id for node_id, incoming in edges.items() if not incoming]
    if len(roots) != 1 or nodes[roots[0]].get("type") != "input":
        raise PackageValidationError(f"{scope} graph requires exactly one input root")
    modules: dict[str, torch.nn.Module] = {}
    kinds: dict[str, str | None] = {}
    for node_id, node in nodes.items():
        if node.get("type") == "input":
            continue
        package_ref = node.get("package")
        if not isinstance(package_ref, Mapping):
            raise PackageValidationError(f"{scope} node {node_id} has no package reference")
        package = _resolve_package(catalog, package_ref)
        kinds[node_id] = package.kind
        builder = load_builder(package, stereotype_runtime_module=stereotype_pytorch)
        context: BuildContext = {
            "node_id": node_id,
            "package_id": package.package_id,
            "parameters": dict(node.get("parameters", node.get("params", {}))),
            "inputs": len(edges[node_id]),
        }
        services = _Services(catalog, node, context, scope)
        try:
            module = builder(context["parameters"], context, services)
        except Exception as exc:
            raise PackageValidationError(f"failed to build {scope} node {node_id}") from exc
        if not isinstance(module, torch.nn.Module):
            raise PackageValidationError(f"builder for {package.package_id} did not return torch.nn.Module")
        modules[node_id] = module
    objective_bindings = {
        node_id: _objective_bindings(catalog, node)
        for node_id, node in nodes.items()
        if kinds.get(node_id) == "loss"
    }
    graph_module = _GraphModule(nodes, edges, modules, kinds, roots[0], objective_bindings)
    programs = _make_programs(graph_module)
    if scope == "root":
        programs._set_adapters(_compile_adapters(graph, catalog, graph_module, programs._objective_nodes))
    elif _selected_adapter_descriptors(graph, catalog):
        raise PackageValidationError("wheel adapters must be selected on the root graph")
    return programs


def _compile_graph(graph: Mapping[str, Any], catalog: dict[tuple[str, str], ValidatedPackage], scope: str) -> torch.nn.Module:
    """Compile a nested graph used by a subflow builder."""

    return _compile_programs(graph, catalog, scope).module


def _normalize_graph(graph: Mapping[str, Any], scope: str, catalog: dict[tuple[str, str], ValidatedPackage]) -> Mapping[str, Any]:
    """Translate the browser's flat parentId graph into runtime scopes."""

    raw_nodes = graph.get("nodes")
    if not isinstance(raw_nodes, list):
        return graph
    if not any(
        isinstance(node, Mapping) and (node.get("type") == "custom" or "parentId" in node)
        for node in raw_nodes
    ):
        return graph

    nodes_by_id = {
        node["id"]: node
        for node in raw_nodes
        if isinstance(node, Mapping) and isinstance(node.get("id"), str)
    }
    if len(nodes_by_id) != len(raw_nodes):
        raise PackageValidationError(f"{scope} graph contains invalid or duplicate node ids")
    raw_edges = graph.get("edges", [])
    if not isinstance(raw_edges, list):
        raise PackageValidationError(f"{scope} graph edges must be a list")

    def make_scope(parent_id: str | None, scope_name: str) -> dict[str, Any]:
        scoped_nodes = [
            node for node in raw_nodes
            if node.get("parentId") == parent_id
        ]
        scoped_ids = {node["id"] for node in scoped_nodes}
        scoped_edges = [
            edge for edge in raw_edges
            if isinstance(edge, Mapping)
            and edge.get("source") in scoped_ids
            and edge.get("target") in scoped_ids
        ]
        normalized_nodes: list[dict[str, Any]] = []
        for node in scoped_nodes:
            package = node.get("package")
            if not isinstance(package, Mapping):
                raise PackageValidationError(f"{scope_name} node {node.get('id')} has no package reference")
            package_value = _resolve_package(catalog, package)
            node_type = node.get("type")
            if package_value.kind == "input" or node_type == "input":
                normalized_nodes.append({"id": node["id"], "type": "input"})
                continue
            runtime_type = "layer" if node_type == "custom" else node_type
            if runtime_type not in {"layer", "join", "subflow"}:
                raise PackageValidationError(f"{scope_name} node {node['id']} has unsupported type {node_type!r}")
            normalized: dict[str, Any] = {
                "id": node["id"],
                "type": runtime_type,
                "package": {"id": package_value.package_id, "version": package_value.version},
                "parameters": dict(node.get("params", node.get("parameters", {}))),
            }
            if "wheelAdapters" in node:
                normalized["wheelAdapters"] = node["wheelAdapters"]
            if runtime_type == "subflow":
                normalized["subflow"] = make_scope(node["id"], f"{scope_name}.{node['id']}")
            normalized_nodes.append(normalized)

        if parent_id is not None:
            incoming = {node["id"]: 0 for node in scoped_nodes}
            for edge in scoped_edges:
                incoming[edge["target"]] += 1
            roots = [node_id for node_id, count in incoming.items() if count == 0]
            if len(roots) != 1:
                raise PackageValidationError(f"{scope_name} subflow requires exactly one boundary root")
            boundary = f"{parent_id}::__input__"
            normalized_nodes.insert(0, {"id": boundary, "type": "input"})
            scoped_edges = [
                {"source": boundary, "target": roots[0], "targetHandle": "in-0"},
                *scoped_edges,
            ]

        return {
            "nodes": normalized_nodes,
            "edges": [
                {
                    "source": edge["source"],
                    "target": edge["target"],
                    "targetHandle": _runtime_handle(edge.get("targetHandle")),
                }
                for edge in scoped_edges
            ],
        }

    return make_scope(None, scope)


def _runtime_handle(handle: Any) -> str:
    """Normalize DiagramCore's shorthand input handle."""

    if handle is None or handle == "in":
        return "in-0"
    return str(handle)


class _ObjectiveBinding(NamedTuple):
    source: str
    transform: str | None


def _objective_bindings(catalog: dict[tuple[str, str], ValidatedPackage], node: Mapping[str, Any]) -> tuple[_ObjectiveBinding, ...]:
    package = _resolve_package(catalog, node["package"])
    definition = package.definition
    objective = definition.get("objective")
    if not isinstance(objective, Mapping):
        raise PackageValidationError(
            f"loss package {package.package_id} must declare objective.externalInputs"
        )
    external = objective.get("externalInputs")
    if not isinstance(external, list):
        raise PackageValidationError(
            f"loss package {package.package_id} objective.externalInputs must be a list"
        )
    bindings: list[_ObjectiveBinding] = []
    names: set[str] = set()
    for binding in external:
        if not isinstance(binding, Mapping):
            raise PackageValidationError(
                f"loss package {package.package_id} has unsupported objective binding"
            )
        name = binding.get("name")
        source = binding.get("source")
        transform = binding.get("transform")
        if not isinstance(name, str) or not name or name in names:
            raise PackageValidationError(f"loss package {package.package_id} has duplicate or invalid binding name")
        if source != "batch.targets":
            raise PackageValidationError(
                f"loss package {package.package_id} has unsupported objective binding source"
            )
        if transform not in (None, "flatten_batch"):
            raise PackageValidationError(
                f"loss package {package.package_id} has unsupported objective binding transform"
            )
        names.add(name)
        bindings.append(_ObjectiveBinding(source, transform))
    return tuple(bindings)


def _make_programs(module: "_GraphModule") -> "CompiledPrograms":
    output_nodes = [node_id for node_id, kind in module._kinds.items() if kind == "output"]
    if len(output_nodes) > 1:
        raise PackageValidationError("package graph requires at most one prediction output")
    objective_nodes = {node_id for node_id, kind in module._kinds.items() if kind == "loss"}
    for node_id in tuple(objective_nodes):
        objective_nodes.update(_descendants(module._edges, node_id))
    prediction_node = output_nodes[0] if output_nodes else None
    if prediction_node is None:
        if objective_nodes:
            raise PackageValidationError("training graph requires an explicit output package")
        terminals = [node_id for node_id in module._nodes if not _outgoing(module._edges, node_id)]
        if len(terminals) != 1:
            raise PackageValidationError("inference graph requires one terminal output")
        prediction_node = terminals[0]
    if prediction_node in objective_nodes:
        raise PackageValidationError("prediction output cannot be part of objective region")
    objective_terminals = [
        node_id for node_id in objective_nodes
        if not any(edge["target"] in objective_nodes for edge in _outgoing(module._edges, node_id))
    ]
    if len(objective_terminals) > 1:
        raise PackageValidationError("training graph requires one objective terminal")
    return CompiledPrograms(module, prediction_node, objective_nodes, objective_terminals[0] if objective_terminals else None)


def _selected_adapter_descriptors(
    graph: Mapping[str, Any] | None,
    catalog: dict[tuple[str, str], ValidatedPackage],
) -> list[dict[str, Any]]:
    """Resolve explicit node selections without executing package Python."""

    if not isinstance(graph, Mapping):
        return []
    raw_nodes = graph.get("nodes")
    if not isinstance(raw_nodes, list):
        return []
    selected: list[dict[str, Any]] = []
    names: set[str] = set()
    for node in raw_nodes:
        if not isinstance(node, Mapping) or "wheelAdapters" not in node:
            continue
        raw_selections = node["wheelAdapters"]
        if not isinstance(raw_selections, list):
            raise PackageValidationError(f"wheelAdapters on node {node.get('id')} must be a list")
        if not raw_selections:
            continue
        node_id = node.get("id")
        if not isinstance(node_id, str) or not node_id:
            raise PackageValidationError("wheel adapter binding requires a node id")
        package_ref = node.get("package")
        if not isinstance(package_ref, Mapping):
            raise PackageValidationError(f"wheel adapter binding on {node_id} has no package")
        package = _resolve_package(catalog, package_ref)
        if node.get("type") == "input" or package.kind in {"input", "loss", "output"}:
            raise PackageValidationError(f"wheel adapter binding on {node_id} must target a stereotype module")
        declarations = package.definition.get("wheelAdapters", [])
        if not isinstance(declarations, list):
            raise PackageValidationError(f"package {package.package_id} wheelAdapters must be a list")
        for selection in raw_selections:
            if not isinstance(selection, Mapping):
                raise PackageValidationError(f"wheel adapter selection on {node_id} must be an object")
            name = selection.get("name")
            if not isinstance(name, str) or not name:
                raise PackageValidationError(f"wheel adapter selection on {node_id} has an invalid name")
            matches = [item for item in declarations if isinstance(item, Mapping) and item.get("name") == name]
            if len(matches) != 1:
                raise PackageValidationError(
                    f"wheel adapter {name!r} on {node_id} is missing or has an ambiguous version"
                )
            declaration = _validate_adapter_declaration(matches[0], package, node_id)
            descriptor = _bind_adapter_declaration(selection, declaration, node_id)
            if descriptor["name"] in names:
                raise PackageValidationError(f"duplicate wheel adapter name {descriptor['name']!r}")
            names.add(descriptor["name"])
            selected.append(descriptor)
    return selected


def _validate_adapter_declaration(
    raw: Mapping[str, Any], package: ValidatedPackage, node_id: str
) -> dict[str, Any]:
    """Validate the version-one adapter contract and attach its concrete binding."""

    name, entrypoint = raw.get("name"), raw.get("entrypoint")
    if not isinstance(name, str) or not name:
        raise PackageValidationError(f"wheel adapter on {node_id} has an invalid name")
    if entrypoint != "module.forward":
        raise PackageValidationError(f"wheel adapter {name!r} must use the module.forward protocol")
    if raw.get("targetPolicy") != "forbidden":
        raise PackageValidationError(f"wheel adapter {name!r} targetPolicy must be forbidden")
    input_schema = raw.get("input")
    if not isinstance(input_schema, Mapping) or input_schema.get("type") != "tensor":
        raise PackageValidationError(f"wheel adapter {name!r} must declare a tensor input")
    _validate_tensor_schema(input_schema, name, "input")
    normalized_input = {key: input_schema[key] for key in ("type", "shape", "dtype") if key in input_schema}
    output = raw.get("output")
    if not isinstance(output, Mapping) or output.get("type") != "tensor":
        raise PackageValidationError(f"wheel adapter {name!r} must declare a tensor output")
    _validate_tensor_schema(output, name, "output")
    randomness = raw.get("randomness", {"mode": "none"})
    if not isinstance(randomness, Mapping) or randomness.get("mode") not in {"none", "seeded"}:
        raise PackageValidationError(f"wheel adapter {name!r} has unsupported randomness policy")
    if randomness.get("mode") == "seeded" and (
        not isinstance(randomness.get("seedInput"), str) or not randomness["seedInput"].strip()
    ):
        raise PackageValidationError(f"wheel adapter {name!r} seeded randomness requires seedInput")
    return {
        "name": name,
        "entrypoint": entrypoint,
        "input": normalized_input,
        "output": {key: output[key] for key in ("type", "shape", "dtype") if key in output},
        "targetPolicy": "forbidden",
        "randomness": randomness,
        "package_id": package.package_id,
        "package_version": package.version,
        "node_id": node_id,
    }


def _bind_adapter_declaration(
    selection: Mapping[str, Any], declaration: dict[str, Any], node_id: str
) -> dict[str, Any]:
    """Bind a concrete node schema to the stereotype's symbolic template."""

    for field in ("input", "output"):
        concrete = selection.get(field)
        if not isinstance(concrete, Mapping) or concrete.get("type") != "tensor":
            raise PackageValidationError(
                f"wheel adapter {declaration['name']!r} binding on {node_id} requires a concrete tensor {field}"
            )
        _validate_concrete_tensor_schema(concrete, declaration["name"], field)

    bindings: dict[str, int] = {}
    _match_declared_shape(
        declaration["input"]["shape"], selection["input"]["shape"], bindings,
        declaration["name"], "input",
    )
    _match_declared_shape(
        declaration["output"]["shape"], selection["output"]["shape"], bindings,
        declaration["name"], "output",
    )
    if selection["input"]["dtype"] != declaration["input"]["dtype"]:
        raise PackageValidationError(f"wheel adapter {declaration['name']!r} input dtype binding is incompatible")
    if selection["output"]["dtype"] != declaration["output"]["dtype"]:
        raise PackageValidationError(f"wheel adapter {declaration['name']!r} output dtype binding is incompatible")
    return {
        **declaration,
        "input": _concrete_schema(selection["input"]),
        "output": _concrete_schema(selection["output"]),
    }


def _validate_concrete_tensor_schema(schema: Mapping[str, Any], name: str, role: str) -> None:
    shape = schema.get("shape")
    if not isinstance(shape, list) or any(
        not (isinstance(item, int) and not isinstance(item, bool) and item > 0)
        for item in shape
    ):
        raise PackageValidationError(f"wheel adapter {name!r} {role} binding shape must be positive integers")
    if schema.get("dtype") not in _ADAPTER_DTYPES:
        raise PackageValidationError(f"wheel adapter {name!r} {role} binding dtype is invalid")


def _concrete_schema(schema: Mapping[str, Any]) -> dict[str, Any]:
    return {"type": "tensor", "shape": list(schema["shape"]), "dtype": schema["dtype"]}


def _match_declared_shape(
    declared: list[Any], concrete: list[int], bindings: dict[str, int], name: str, role: str,
) -> None:
    if len(declared) != len(concrete):
        raise PackageValidationError(f"wheel adapter {name!r} {role} binding rank is incompatible")
    for index, (expected, actual) in enumerate(zip(declared, concrete)):
        if isinstance(expected, int):
            if expected != actual:
                raise PackageValidationError(
                    f"wheel adapter {name!r} {role} binding dimension {index} is incompatible"
                )
            continue
        previous = bindings.setdefault(expected, actual)
        if previous != actual:
            raise PackageValidationError(
                f"wheel adapter {name!r} {role} binding symbol {expected!r} is inconsistent"
            )


def _validate_tensor_schema(schema: Mapping[str, Any], name: str, role: str) -> None:
    shape = schema.get("shape")
    dtype = schema.get("dtype")
    if not isinstance(shape, list) or any(
        not ((isinstance(item, int) and not isinstance(item, bool) and item > 0) or
             (isinstance(item, str) and bool(item.strip())))
        for item in shape
    ):
        raise PackageValidationError(f"wheel adapter {name!r} {role} tensor shape is invalid")
    if dtype not in {"float16", "bfloat16", "float32", "float64"}:
        raise PackageValidationError(f"wheel adapter {name!r} {role} tensor dtype is invalid")


def _compile_adapters(
    graph: Mapping[str, Any],
    catalog: dict[tuple[str, str], ValidatedPackage],
    module: "_GraphModule",
    objective_nodes: set[str],
) -> dict[str, "_CompiledAdapter"]:
    adapters: dict[str, _CompiledAdapter] = {}
    for descriptor in _selected_adapter_descriptors(graph, catalog):
        node_id = descriptor["node_id"]
        if node_id in objective_nodes:
            raise PackageValidationError(f"wheel adapter {descriptor['name']!r} cannot bind to objective nodes")
        adapters[descriptor["name"]] = _CompiledAdapter(
            descriptor, _BoundModule(module.modules_by_id[node_id])
        )
    return adapters


def _descendants(edges: dict[str, list[dict[str, Any]]], root: str) -> set[str]:
    result: set[str] = set()
    pending = [root]
    while pending:
        current = pending.pop()
        for edge in _outgoing(edges, current):
            child = edge["target"]
            if child not in result:
                result.add(child)
                pending.append(child)
    return result


class CompiledPrograms(torch.nn.Module):
    """Two graph views backed by one module store and one parameter set."""

    def __init__(self, module: "_GraphModule", prediction_node: str, objective_nodes: set[str], objective_node: str | None) -> None:
        super().__init__()
        self.module = module
        self.prediction_program = PredictionProgram(module, prediction_node, objective_nodes)
        self.objective_program = ObjectiveProgram(module, objective_node, objective_nodes)
        self._objective_nodes = objective_nodes
        self._adapters: dict[str, _CompiledAdapter] = {}

    def _set_adapters(self, adapters: dict[str, "_CompiledAdapter"]) -> None:
        """Attach adapters after graph compilation without rebuilding modules."""

        self._adapters = adapters

    @property
    def adapter_specs(self) -> tuple[dict[str, Any], ...]:
        """Return immutable metadata for the explicitly selected adapters."""

        return tuple(adapter.descriptor for adapter in self._adapters.values())

    def adapter(self, name: str) -> "_CompiledAdapter":
        """Return one declared adapter by its stable public name."""

        if not isinstance(name, str) or not name:
            raise ValueError("adapter name must be a non-empty string")
        try:
            return self._adapters[name]
        except KeyError as exc:
            raise KeyError(f"unknown wheel adapter: {name}") from exc

    @property
    def modules_by_id(self) -> torch.nn.ModuleDict:
        return self.module.modules_by_id

    def forward(self, inputs: torch.Tensor) -> torch.Tensor:
        """Compatibility forwarding entrypoint for prediction only."""

        return self.prediction(inputs)

    def prediction(self, inputs: torch.Tensor) -> torch.Tensor:
        return self.prediction_program(inputs)

    def objective(self, inputs: torch.Tensor, targets: torch.Tensor) -> torch.Tensor:
        return self.objective_program(inputs, targets)


class PredictionProgram:
    def __init__(self, module: "_GraphModule", output_node: str, objective_nodes: set[str]) -> None:
        self._module, self._output_node, self._objective_nodes = module, output_node, objective_nodes

    def __call__(self, inputs: torch.Tensor) -> torch.Tensor:
        values = self._module.evaluate(inputs, None, self._output_node, self._objective_nodes)
        return values[self._output_node]


class ObjectiveProgram:
    def __init__(self, module: "_GraphModule", objective_node: str | None, objective_nodes: set[str]) -> None:
        self._module, self._objective_node, self._objective_nodes = module, objective_node, objective_nodes

    def __call__(self, inputs: torch.Tensor, targets: torch.Tensor) -> torch.Tensor:
        if self._objective_node is None:
            raise PackageValidationError("training requires an objective node")
        values = self._module.evaluate(inputs, targets, self._objective_node, set())
        objective = values[self._objective_node]
        if objective.ndim != 0:
            raise PackageValidationError("objective program must return a scalar tensor")
        return objective


class _GraphModule(torch.nn.Module):
    def __init__(self, nodes: dict[str, Mapping[str, Any]], edges: dict[str, list[dict[str, Any]]], modules: dict[str, torch.nn.Module], kinds: dict[str, str | None], root: str, objective_bindings: dict[str, tuple[_ObjectiveBinding, ...]]) -> None:
        super().__init__()
        self.modules_by_id = torch.nn.ModuleDict(modules)
        self._nodes, self._edges, self._kinds, self._root = nodes, edges, kinds, root
        self._objective_bindings = objective_bindings

    def forward(self, value: torch.Tensor) -> torch.Tensor:
        """Execute a nested graph as a normal PyTorch submodule."""

        terminals = [node_id for node_id in self._nodes if not _outgoing(self._edges, node_id)]
        if len(terminals) != 1:
            raise PackageValidationError("nested graph requires one terminal")
        return self.evaluate(value, None, terminals[0], set())[terminals[0]]

    def evaluate(self, value: torch.Tensor, target: torch.Tensor | None, terminal: str, excluded: set[str]) -> dict[str, torch.Tensor]:
        values: dict[str, torch.Tensor] = {self._root: value}
        pending = [self._root]
        queued = {self._root}
        while pending:
            ready_index = next(
                (
                    index
                    for index, candidate in enumerate(pending)
                    if all(edge["source"] in values for edge in self._edges[candidate])
                ),
                None,
            )
            if ready_index is None:
                raise RuntimeError("package graph cannot be evaluated in dependency order")
            node_id = pending.pop(ready_index)
            node = self._nodes[node_id]
            inputs = [values[edge["source"]] for edge in self._edges[node_id]]
            if node_id != self._root:
                if node_id in excluded:
                    continue
                module = self.modules_by_id[node_id]
                if self._kinds.get(node_id) == "loss":
                    bindings = self._objective_bindings[node_id]
                    if len(bindings) and target is None:
                        raise PackageValidationError(f"objective node {node_id} requires batch.targets")
                    args = [*inputs, *(_adapt_objective_input(target, binding.transform) for binding in bindings if binding.source == "batch.targets")]
                    output = module(*args)
                else:
                    output = module(*inputs)
                values[node_id] = output
            if node_id == terminal:
                return values
            for edge in _outgoing(self._edges, node_id):
                target_id = edge["target"]
                if target_id not in queued and target_id not in excluded:
                    pending.append(target_id)
                    queued.add(target_id)
        raise PackageValidationError(f"graph cannot reach terminal node {terminal}")


def _adapt_objective_input(target: torch.Tensor | None, transform: str | None) -> torch.Tensor:
    """Apply the loss package's declared target adaptation, never an inferred one."""

    if target is None:
        raise PackageValidationError("objective binding requires batch.targets")
    if transform is None:
        return target
    if transform == "flatten_batch":
        return target.flatten(start_dim=1)
    raise PackageValidationError(f"unsupported objective input transform: {transform!r}")


class _Services:
    def __init__(self, catalog: dict[tuple[str, str], ValidatedPackage], node: Mapping[str, Any], context: BuildContext, scope: str) -> None:
        self.catalog, self.node, self.context, self.scope = catalog, node, context, scope

    def build_subflow(self) -> torch.nn.Module:
        subflow = self.node.get("subflow")
        if not isinstance(subflow, Mapping):
            raise PackageValidationError(f"{self.scope} node {self.context['node_id']} has no subflow")
        return _compile_graph(subflow, self.catalog, f"{self.scope}.{self.context['node_id']}")

    def build_stereotype(self, reference: StereotypeReference, context: BuildContext | None = None) -> torch.nn.Module:
        package = _resolve_package(self.catalog, reference)
        builder = load_builder(package)
        params = dict(reference.get("parameters", {}))
        return builder(params, context or self.context, self)


def _resolve_package(catalog: dict[tuple[str, str], ValidatedPackage], reference: Mapping[str, Any]) -> ValidatedPackage:
    key = (reference.get("id"), reference.get("version"))
    package = catalog.get(key)
    if package is None:
        raise PackageValidationError(f"package {key[0]}@{key[1]} is not in dependency closure")
    return package


def _validate_edges(raw_edges: list[Any], nodes: dict[str, Mapping[str, Any]], scope: str) -> dict[str, list[dict[str, Any]]]:
    incoming = {node_id: [] for node_id in nodes}
    for edge in raw_edges:
        if not isinstance(edge, Mapping) or edge.get("source") not in nodes or edge.get("target") not in nodes:
            raise PackageValidationError(f"{scope} graph contains an invalid edge")
        target = edge["target"]
        incoming[target].append({"source": edge["source"], "target": target, "targetHandle": edge.get("targetHandle", "in-0")})
    for edges in incoming.values():
        edges.sort(key=lambda edge: _handle_index(edge["targetHandle"]))
    return incoming


def _handle_index(handle: str) -> int:
    if not isinstance(handle, str) or not handle.startswith("in-") or not handle[3:].isdigit():
        raise PackageValidationError(f"invalid targetHandle: {handle!r}")
    return int(handle[3:])


def _ensure_acyclic(nodes: dict[str, Mapping[str, Any]], incoming: dict[str, list[dict[str, Any]]], scope: str) -> None:
    state: dict[str, int] = {}

    def visit(node_id: str) -> None:
        if state.get(node_id) == 1:
            raise PackageValidationError(f"{scope} graph contains a cycle")
        if state.get(node_id) == 2:
            return
        state[node_id] = 1
        for edge in _outgoing(incoming, node_id):
            visit(edge["target"])
        state[node_id] = 2

    for node_id in nodes:
        visit(node_id)


def _outgoing(incoming: dict[str, list[dict[str, Any]]], source: str) -> list[dict[str, Any]]:
    return [edge for edges in incoming.values() for edge in edges if edge["source"] == source]


class _BoundModule:
    """Narrow callable capability passed to the fixed module.forward adapter."""

    __slots__ = ("_module",)

    def __init__(self, module: torch.nn.Module) -> None:
        self._module = module

    def __call__(self, value: torch.Tensor) -> torch.Tensor:
        devices = {parameter.device for parameter in self._module.parameters()}
        devices.update(buffer.device for buffer in self._module.buffers())
        if len(devices) == 1:
            value = value.to(next(iter(devices)))
        return self._module(value)


class _CompiledAdapter:
    """A typed, target-free view of one compiled stereotype instance."""

    def __init__(self, descriptor: dict[str, Any], module: _BoundModule) -> None:
        self.descriptor = descriptor
        self._module = module

    def __call__(self, value: object) -> torch.Tensor:
        input_schema = self.descriptor["input"]
        tensor = _adapter_input_tensor(value, input_schema, self.descriptor["name"])
        bindings: dict[str, int] = {}
        _match_adapter_shape(tensor.shape, input_schema["shape"], bindings, "input")
        output = self._module(tensor)
        if not isinstance(output, torch.Tensor):
            raise PackageValidationError("wheel adapter module.forward must return a torch.Tensor")
        output_schema = self.descriptor["output"]
        if output.dtype != _adapter_dtype(output_schema["dtype"]):
            raise TypeError(
                f"wheel adapter {self.descriptor['name']!r} output dtype {output.dtype} does not match "
                f"{output_schema['dtype']}"
            )
        _match_adapter_shape(output.shape, output_schema["shape"], bindings, "output")
        return output


_ADAPTER_DTYPES = {
    "float16": torch.float16,
    "bfloat16": torch.bfloat16,
    "float32": torch.float32,
    "float64": torch.float64,
}


def _adapter_dtype(name: str) -> torch.dtype:
    return _ADAPTER_DTYPES[name]


def _adapter_input_tensor(value: object, schema: Mapping[str, Any], name: str) -> torch.Tensor:
    expected = _adapter_dtype(schema["dtype"])
    if isinstance(value, torch.Tensor):
        tensor = value
    else:
        if not _numeric_sequence(value):
            raise TypeError(f"wheel adapter {name!r} expects a tensor or nested numeric sequence")
        try:
            tensor = torch.as_tensor(value, dtype=expected)
        except (TypeError, ValueError, RuntimeError) as exc:
            raise TypeError(f"wheel adapter {name!r} input is not a rectangular numeric sequence") from exc
    if tensor.dtype != expected:
        raise TypeError(
            f"wheel adapter {name!r} input dtype {tensor.dtype} does not match {schema['dtype']}"
        )
    return tensor


def _numeric_sequence(value: object) -> bool:
    if isinstance(value, bool) or isinstance(value, (str, bytes)):
        return False
    if isinstance(value, (int, float)):
        return True
    if isinstance(value, (list, tuple)):
        return all(_numeric_sequence(item) for item in value)
    return False


def _match_adapter_shape(
    actual: torch.Size,
    declared: list[Any],
    bindings: dict[str, int],
    role: str,
) -> None:
    if len(actual) != len(declared):
        raise ValueError(f"wheel adapter {role} rank {len(actual)} does not match declared rank {len(declared)}")
    for index, (actual_dimension, declared_dimension) in enumerate(zip(actual, declared)):
        if isinstance(declared_dimension, int):
            if actual_dimension != declared_dimension:
                raise ValueError(
                    f"wheel adapter {role} dimension {index} is {actual_dimension}, expected {declared_dimension}"
                )
            continue
        previous = bindings.setdefault(declared_dimension, actual_dimension)
        if previous != actual_dimension:
            raise ValueError(
                f"wheel adapter {role} symbol {declared_dimension!r} has inconsistent dimension"
            )


def _version_matches(version: str, requirement: str) -> bool:
    return requirement == version or (requirement.startswith("^") and version.split(".")[0] == requirement[1:].split(".")[0])
