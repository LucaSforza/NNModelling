"""Lifecycle manager for compiled Observable definitions."""

from __future__ import annotations

import ast
import importlib
import warnings
from typing import Any

from interpretability.base import CaptureContext
from interpretability.publishers import ResultPublisher

_PHASES = {"IMMEDIATE", "POST_BATCH", "POST_STEP", "POST_EPOCH", "POST_RUN"}
_SCOPES = {"LAST", "BATCH", "EPOCH", "RUN"}
_STORAGE = {"FULL", "STREAMING", "SAMPLED"}


def _literal(value: Any) -> Any:
    """Parse source-style scalar/list values without executing code."""
    if not isinstance(value, str):
        return value
    try:
        return ast.literal_eval(value)
    except (ValueError, SyntaxError):
        return value


def _bool(value: Any) -> bool:
    value = _literal(value)
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.lower() in {"true", "false"}:
        return value.lower() == "true"
    raise ValueError(f"expected boolean, got {value!r}")


class ObservableManager:
    """Own passive analyses, hooks and transient state outside the module tree."""

    def __init__(
        self,
        config: Any = None,
        source_registry: dict[str, Any] | None = None,
        global_enabled: bool = True,
        publisher: ResultPublisher | None = None,
        manual_sources: set[str] | None = None,
    ) -> None:
        self.config = config
        self.source_registry = source_registry or {}
        self.manual_sources = manual_sources or set()
        self.global_enabled = global_enabled
        self.publisher = publisher or ResultPublisher()
        self.observables: list[Any] = []
        self.handles: list[Any] = []
        self.mode = "EVAL"
        self.context = CaptureContext()
        self.scope_id = "manual"
        self._scope_finalized = False
        self._phase_done: set[tuple[str, str, str, int | None, int | None, int | None]] = set()
        self._build()

    def _build(self) -> None:
        if not self.global_enabled or self.config is None or not self.config.get("enabled", False):
            return
        for raw in self.config.get("observables", {}).values():
            try:
                cfg = self._normalize(dict(raw))
                if not cfg["enabled"]:
                    continue
                module_name, class_name = cfg["pythonClassName"].rsplit(".", 1)
                cls = getattr(importlib.import_module(module_name), class_name)
                self.observables.append(cls(cfg, self.publisher))
            except (ImportError, AttributeError, KeyError, TypeError, ValueError) as error:
                warnings.warn(f"Skipping Observable {dict(raw).get('id')}: {error}", RuntimeWarning)

    def _normalize(self, cfg: dict[str, Any]) -> dict[str, Any]:
        cfg["id"] = str(cfg.get("id", ""))
        cfg["enabled"] = _bool(cfg.get("enabled", True))
        cfg["executionModes"] = _literal(cfg.get("executionModes", ["TRAIN", "EVAL", "PREDICT"]))
        if isinstance(cfg["executionModes"], str):
            raise ValueError("executionModes must be a list")
        cfg["retentionScope"] = str(cfg.get("retentionScope", "RUN")).upper()
        cfg["storageStrategy"] = str(cfg.get("storageStrategy", "SAMPLED")).upper()
        cfg["finalizePhase"] = str(cfg.get("finalizePhase", "POST_RUN")).upper()
        cfg["move_to_cpu"] = _bool(cfg.get("move_to_cpu", True))
        cfg["detach"] = _bool(cfg.get("detach", True))
        cfg["sample_every"] = int(_literal(cfg.get("sample_every", 1)))
        cfg["max_samples"] = int(_literal(cfg.get("max_samples", 128)))
        if cfg["sample_every"] < 1 or cfg["max_samples"] < 0:
            raise ValueError("sample_every must be >= 1 and max_samples must be >= 0")
        if cfg["finalizePhase"] not in _PHASES or cfg["retentionScope"] not in _SCOPES:
            raise ValueError("unsupported Observable lifecycle value")
        if cfg["storageStrategy"] not in _STORAGE:
            raise ValueError("unsupported Observable storage value")
        execution = set(cfg["executionModes"])
        supported_modes = set(cfg.get("supportedModes", execution))
        supported_retention = set(cfg.get("supportedRetentionScopes", _SCOPES))
        supported_storage = set(cfg.get("supportedStorageStrategies", _STORAGE))
        if not execution or not execution <= supported_modes:
            raise ValueError("executionModes is not a subset of supportedModes")
        if cfg["retentionScope"] not in supported_retention or cfg["storageStrategy"] not in supported_storage:
            raise ValueError("unsupported retention/storage combination")
        inputs = cfg.get("inputs", [])
        if not inputs:
            raise ValueError("at least one Observable input is required")
        for item in inputs:
            source_value = item.get("sourceNodeId")
            if item.get("required", True) and not source_value:
                raise ValueError("required Observable input has no source")
            if not source_value:
                continue
            if item.get("sourcePoint", "out") != "out":
                raise ValueError("only the public out point is supported")
            source = str(source_value)
            if source not in self.source_registry and source not in self.manual_sources:
                raise ValueError(f"source {source!r} is not bound")
        return cfg

    def attach(self) -> None:
        """Attach one passive hook per registered module source."""
        if self.handles:
            for handle in self.handles:
                handle.remove()
            self.handles.clear()
        sources = {
            input_spec.get("sourceNodeId")
            for observable in self.observables
            for input_spec in observable.config.get("inputs", [])
            if input_spec.get("sourceNodeId") in self.source_registry
        }
        for source in sources:
            modules = self.source_registry[source]
            if not isinstance(modules, (list, tuple)):
                modules = [modules]
            for module in modules:
                if module is None or not hasattr(module, "register_forward_hook"):
                    continue

                def callback(_module: Any, _inputs: Any, output: Any, source_id: str = source) -> None:
                    self.capture(source_id, output)
                    return None

                self.handles.append(module.register_forward_hook(callback))

    def begin_scope(self, scope_id: str, mode: str | None = None) -> None:
        """Start an independent fit, test, or predict scope."""
        if scope_id == self.scope_id and not self._scope_finalized:
            return
        self.scope_id = scope_id
        self._scope_finalized = False
        self._phase_done.clear()
        for observable in self.observables:
            observable.begin_scope()
        if mode is not None:
            self.set_context(mode)

    def capture(self, source: str, value: Any) -> None:
        """Dispatch capture defensively; an analysis cannot break forward."""
        if not self.global_enabled or self._scope_finalized or self.mode not in {"TRAIN", "EVAL", "PREDICT"}:
            return None
        for observable in self.observables:
            if self.mode not in observable.config.get("executionModes", []):
                continue
            if not any(spec.get("sourceNodeId") == source for spec in observable.config.get("inputs", [])):
                continue
            try:
                observable.reset_retention("LAST")
                observable.capture(value, self.context, source)
                if observable.config.get("finalizePhase") == "IMMEDIATE":
                    self._finalize_one(observable, "IMMEDIATE")
            except Exception as error:
                warnings.warn(f"Observable {observable.config.get('id')} capture failed: {error}", RuntimeWarning)
        return None

    def set_context(
        self, mode: str, epoch: int | None = None, global_step: int | None = None, batch_index: int | None = None
    ) -> None:
        self.mode = mode
        self.context = CaptureContext(mode, epoch, global_step, batch_index)

    def _phase_key(self, phase: str) -> tuple[str, str, str, int | None, int | None, int | None]:
        if phase == "POST_RUN":
            return (self.scope_id, self.mode, phase, None, None, None)
        return (self.scope_id, self.mode, phase, self.context.epoch, self.context.global_step, self.context.batch_index)

    def _finalize_one(self, observable: Any, phase: str) -> list[dict[str, Any]]:
        if observable.config.get("finalizePhase") != phase:
            return []
        try:
            return observable.finalize_all(self.context)
        except Exception as error:
            warnings.warn(f"Observable {observable.config.get('id')} finalize failed: {error}", RuntimeWarning)
            observable.clear()
            return []

    def finalize(self, phase: str) -> list[dict[str, Any]]:
        """Finalize a phase once, then enforce its retention boundary."""
        if phase not in _PHASES:
            raise ValueError(f"Unknown Observable finalize phase: {phase}")
        key = self._phase_key(phase)
        if key in self._phase_done:
            return []
        self._phase_done.add(key)
        results = []
        # Capture eligibility is mode-aware, but finalization belongs to the
        # Observable's retained state rather than to the manager's last
        # context.  Lightning can leave TRAIN for validation before POST_RUN;
        # filtering here would silently discard a TRAIN-only Observable.
        for observable in self.observables:
            results.extend(self._finalize_one(observable, phase))
            boundary = {"POST_BATCH": "BATCH", "POST_STEP": "BATCH", "POST_EPOCH": "EPOCH", "POST_RUN": "RUN"}.get(phase)
            if boundary and observable.config.get("retentionScope") == boundary:
                try:
                    observable.seal_window(boundary, self.context)
                except Exception as error:
                    warnings.warn(f"Observable {observable.config.get('id')} window seal failed: {error}", RuntimeWarning)
                    observable.clear()
                observable.reset_retention(boundary)
        if phase == "POST_RUN":
            self._scope_finalized = True
            for observable in self.observables:
                observable.clear()
        return results

    def end_scope(self) -> list[dict[str, Any]]:
        """Finalize POST_RUN exactly once and release all scope buffers."""
        return self.finalize("POST_RUN")

    def clear(self) -> None:
        """Detach hooks and release all captured tensors before serialization."""
        for handle in self.handles:
            handle.remove()
        self.handles.clear()
        for observable in self.observables:
            observable.clear()

    def clear_for_serialization(self) -> None:
        """Release all transient runtime state without removing publications.

        Durable local metadata and tensor artifacts remain in the publisher's
        run directory.  Everything that could retain a completed run in a
        whole-model pickle is reset, including publisher rows, publication
        keys, artifact references, and external logger objects.
        """
        self.clear()
        self.publisher.clear_transient()
        self._phase_done.clear()
        self._scope_finalized = False
        self.scope_id = "manual"
        self.mode = "EVAL"
        self.context = CaptureContext()

    def configure_run(self, run_root: str | None = None, run_id: str | None = None) -> None:
        """Move publication to a new isolated run without rebuilding analyses.

        Direct inference uses this after loading a serialized model so its
        prediction rows cannot be appended to the training run.
        """
        self.publisher = ResultPublisher(
            run_root=run_root,
            experiment=self.publisher.experiment,
            wandb_module=self.publisher.wandb,
            run_id=run_id,
        )
        for observable in self.observables:
            observable.publisher = self.publisher

    close = clear
