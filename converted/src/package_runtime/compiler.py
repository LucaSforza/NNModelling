"""Compile a validated package graph into a PyTorch module."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import torch

from stereotype_runtime.pytorch import BuildContext, StereotypeReference

from .loader import PackageValidationError, ValidatedPackage, load_builder, validate_bundle


def compile_package_graph(bundle: Mapping[str, Any]) -> torch.nn.Module:
    """Validate and compile a package graph, preserving explicit join order."""

    packages = _package_catalog(bundle)
    graph = bundle.get("graph")
    if not isinstance(graph, Mapping):
        raise PackageValidationError("package requires a graph")
    return _compile_graph(graph, packages, "root")


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


def _compile_graph(graph: Mapping[str, Any], catalog: dict[tuple[str, str], ValidatedPackage], scope: str) -> torch.nn.Module:
    graph = _normalize_graph(graph, scope)
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
    for node_id, node in nodes.items():
        if node.get("type") == "input":
            continue
        package_ref = node.get("package")
        if not isinstance(package_ref, Mapping):
            raise PackageValidationError(f"{scope} node {node_id} has no package reference")
        package = _resolve_package(catalog, package_ref)
        builder = load_builder(package)
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
    return _GraphModule(nodes, edges, modules, roots[0])


def _normalize_graph(graph: Mapping[str, Any], scope: str) -> Mapping[str, Any]:
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
            package_id = package.get("id")
            node_type = node.get("type")
            if package_id == "core.input":
                normalized_nodes.append({"id": node["id"], "type": "input"})
                continue
            runtime_type = "layer" if node_type == "custom" else node_type
            if runtime_type not in {"layer", "join", "subflow"}:
                raise PackageValidationError(f"{scope_name} node {node['id']} has unsupported type {node_type!r}")
            normalized: dict[str, Any] = {
                "id": node["id"],
                "type": runtime_type,
                "package": {
                    "id": package.get("id"),
                    "version": package.get("version"),
                },
                "parameters": dict(node.get("params", node.get("parameters", {}))),
            }
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


class _GraphModule(torch.nn.Module):
    def __init__(self, nodes: dict[str, Mapping[str, Any]], edges: dict[str, list[dict[str, Any]]], modules: dict[str, torch.nn.Module], root: str) -> None:
        super().__init__()
        self.modules_by_id = torch.nn.ModuleDict(modules)
        self._nodes, self._edges, self._root = nodes, edges, root

    def forward(self, value: torch.Tensor, target: torch.Tensor | None = None) -> torch.Tensor:
        values: dict[str, torch.Tensor] = {self._root: value}
        pending = [self._root]
        queued = {self._root}
        output = value
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
                module = self.modules_by_id[node_id]
                if isinstance(module, torch.nn.MSELoss) and len(inputs) == 1:
                    reference = value if target is None else target
                    if reference.numel() == inputs[0].numel() and reference.shape != inputs[0].shape:
                        reference = reference.reshape_as(inputs[0])
                    output = module(inputs[0], reference)
                else:
                    output = module(*inputs)
                values[node_id] = output
            else:
                output = values[node_id]
            for edge in _outgoing(self._edges, node_id):
                target_id = edge["target"]
                if target_id not in queued:
                    pending.append(target_id)
                    queued.add(target_id)
        return output


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


def _version_matches(version: str, requirement: str) -> bool:
    return requirement == version or (requirement.startswith("^") and version.split(".")[0] == requirement[1:].split(".")[0])
