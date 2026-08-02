"""Runtime stereotype catalogs: repository built-ins plus project-local JSON.

The companion serves stereotypes in a stable wire form — catalog-relative
path plus the complete JSON definition — so the browser's ``StereotypeCore``
can reconstruct them exactly as it does at build time. Project-local
definitions are validated structurally, and a project stereotype whose name
collides with a built-in (or another project file) is rejected explicitly with
an actionable diagnostic instead of silently overriding the built-in.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Literal

from backend.project_schema import StereotypeCatalogEntry, StereotypeCatalogResponse

BUILTIN_DIR_ENV = "NNM_STEREOTYPES"
KNOWN_CATEGORIES = {"Input", "Fork", "Layer", "Loss", "Join", "Subflow", "Module"}
_MAX_DIAGNOSTIC = 2000


def builtin_stereotype_dir() -> Path:
    """Return the repository ``Stereotypes`` directory.

    The ``NNM_STEREOTYPES`` environment override matches the override already
    honored by the MCP server and supports tests and deployed layouts.
    """
    override = os.getenv(BUILTIN_DIR_ENV)
    if override:
        return Path(override).expanduser().resolve()
    return Path(__file__).resolve().parents[3] / "Stereotypes"


def load_builtin_stereotypes() -> tuple[list[StereotypeCatalogEntry], list[dict[str, str]]]:
    """Load every repository stereotype as a trusted catalog entry."""
    return _load_directory(builtin_stereotype_dir(), source="builtin", prefix="Stereotypes")


def discover_project_stereotypes(
    project_root: str | Path,
) -> tuple[list[StereotypeCatalogEntry], list[dict[str, str]]]:
    """Load validated project-local stereotypes from ``<root>/stereotypes``."""
    return _load_directory(
        Path(project_root) / "stereotypes",
        source="project",
        prefix="project-stereotypes",
    )


def merge_stereotype_catalog(
    builtin: list[StereotypeCatalogEntry],
    project: list[StereotypeCatalogEntry],
) -> tuple[list[StereotypeCatalogEntry], list[dict[str, str]]]:
    """Merge built-ins with project stereotypes, rejecting name collisions.

    A project stereotype whose name matches a built-in (or appears twice among
    the project files) is excluded and reported in the returned errors; the
    built-in definition always wins so opening a project can never silently
    change the meaning of a built-in layer.
    """
    errors: list[dict[str, str]] = []
    entries = list(builtin)
    builtin_names = {entry.name for entry in entries}
    project_names: set[str] = set()
    for entry in project:
        if entry.name in builtin_names:
            errors.append(
                {
                    "path": entry.id,
                    "error": (
                        f"project stereotype {entry.name!r} collides with a built-in "
                        "stereotype and was rejected"
                    ),
                }
            )
            continue
        if entry.name in project_names:
            errors.append(
                {
                    "path": entry.id,
                    "error": f"duplicate project stereotype name {entry.name!r} was rejected",
                }
            )
            continue
        project_names.add(entry.name)
        entries.append(entry)
    entries.sort(key=lambda entry: (entry.source, entry.name))
    return entries, errors


def build_project_catalog(
    project_root: str | Path,
) -> StereotypeCatalogResponse:
    """Combine built-ins with a project's stereotypes and all diagnostics."""
    builtin, builtin_errors = load_builtin_stereotypes()
    project, project_errors = discover_project_stereotypes(project_root)
    merged, collision_errors = merge_stereotype_catalog(builtin, project)
    return StereotypeCatalogResponse(
        stereotypes=merged,
        errors=[*builtin_errors, *project_errors, *collision_errors],
    )


def _load_directory(
    root: Path,
    *,
    source: Literal["builtin", "project"],
    prefix: str,
) -> tuple[list[StereotypeCatalogEntry], list[dict[str, str]]]:
    """Load every ``*.json`` under ``root``, reporting per-file diagnostics."""
    entries: list[StereotypeCatalogEntry] = []
    errors: list[dict[str, str]] = []
    if not root.is_dir():
        return entries, errors
    for path in sorted(root.rglob("*.json")):
        rel = path.relative_to(root).as_posix()
        name = path.stem
        if not _resolves_inside_root(path, root):
            errors.append(
                {
                    "path": rel,
                    "error": f"{rel}: resolves outside the stereotype directory and was ignored",
                }
            )
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            errors.append({"path": rel, "error": _diagnostic(f"{rel}: invalid JSON: {exc}")})
            continue
        except OSError as exc:
            errors.append({"path": rel, "error": _diagnostic(f"{rel}: cannot be read: {exc}")})
            continue
        problem = _validate_definition(name, data, strict_category=source == "project")
        if problem is not None:
            errors.append({"path": rel, "error": _diagnostic(f"{rel}: {problem}")})
            continue
        entries.append(
            StereotypeCatalogEntry(id=f"{prefix}/{rel}", name=name, source=source, data=data)
        )
    return entries, errors


def _resolves_inside_root(candidate: Path, root: Path) -> bool:
    """Return whether a candidate's physical target stays inside the root.

    The candidate path is resolved with symlinks fully followed; only a proper
    descendant of the resolved root is considered inside. A symlinked file
    whose target (or whose chain of symlinks) escapes the root — including a
    broken symlink whose target path lies outside — is rejected before it can
    be read, so project discovery never exposes files reachable only through a
    symlink planted outside ``stereotypes/``.
    """
    resolved_root = root.resolve()
    resolved = candidate.resolve()
    return resolved != resolved_root and resolved_root in resolved.parents


def _validate_definition(name: str, data: object, *, strict_category: bool) -> str | None:
    """Validate one stereotype definition, returning an error message or None.

    Built-in definitions are structurally validated but trusted for category
    membership (a future built-in category must not break every response);
    project definitions are validated strictly so a typo'd category is
    diagnosed instead of silently degrading in the editor.
    """
    if not isinstance(data, dict):
        return "stereotype definition must be a JSON object"
    if not name:
        return "stereotype filename must not be empty"
    category = data.get("category")
    if category is not None and not isinstance(category, str):
        return "stereotype category must be a string"
    if strict_category and category is not None and category not in KNOWN_CATEGORIES:
        return f"stereotype category {category!r} is not recognized"
    for field in ("pythonClassName", "taskType"):
        value = data.get(field)
        if value is not None and not isinstance(value, str):
            return f"stereotype {field} must be a string"
    for field in ("params", "view", "type_signature"):
        value = data.get(field)
        if value is not None and not isinstance(value, dict):
            return f"stereotype {field} must be a JSON object"
    return None


def _diagnostic(message: str) -> str:
    """Bound the length of a client-visible diagnostic."""
    return message if len(message) <= _MAX_DIAGNOSTIC else message[: _MAX_DIAGNOSTIC - 3] + "..."
