"""Common contracts for Observable runtime implementations."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

import torch

ExecutionMode = str
FinalizePhase = str


@dataclass
class CaptureContext:
    """Metadata associated with one model execution."""

    mode: ExecutionMode = "EVAL"
    epoch: int | None = None
    global_step: int | None = None
    batch_index: int | None = None


@dataclass
class ObservableState:
    """Per-observable temporary state, deliberately not an nn.Module buffer."""

    rows: list[dict[str, Any]] = field(default_factory=list)
    tensors: list[torch.Tensor] = field(default_factory=list)
    count: int = 0
    seen: int = 0


class Observable:
    """Small protocol-like base class for passive analyses."""

    def __init__(self, config: dict[str, Any], publisher: Any) -> None:
        self.config = config
        self.publisher = publisher
        self._states: dict[str, ObservableState] = {}
        self.state = self._state("EVAL")
        self.enabled = bool(config.get("enabled", True))

    def _state(self, mode: str) -> ObservableState:
        """Return state isolated to one execution mode."""
        if mode not in self._states:
            self._states[mode] = ObservableState()
        self.state = self._states[mode]
        return self.state

    def begin_scope(self) -> None:
        """Discard all prior mode state at a fit/test/predict boundary."""
        self._states.clear()
        self.state = self._state("EVAL")

    def reset_retention(self, scope: str) -> None:
        """Reset state at the boundary described by RetentionScope."""
        if self.config.get("retentionScope") in {scope, "LAST"}:
            for state in self._states.values():
                state.tensors.clear()
                state.rows.clear()
                state.count = 0
                state.seen = 0

    def seal_window(self, scope: str, context: CaptureContext) -> None:
        """Seal a retention window before its heavy state is reset."""

    def finalize_all(self, context: CaptureContext) -> list[dict[str, Any]]:
        """Finalize every mode bucket without combining TRAIN and EVAL."""
        results = []
        for mode in list(self._states):
            result = self._finalize_mode(mode, context)
            if result is not None:
                results.append(result)
        return results

    def capture(self, value: torch.Tensor, context: CaptureContext, source: str) -> None:
        """Consume a value without returning a replacement tensor."""
        raise NotImplementedError

    def common_result_metadata(self, context: CaptureContext) -> dict[str, Any]:
        """Return metadata shared by every finalized result row.

        ``inputs`` is already ordered by the compiler using the Observable
        target handles.  Keep that order here rather than reconstructing it
        from captures: streaming analyses can receive several sources and
        their capture order is not a stable representation of the diagram.
        The additive ``sources`` field preserves the compiled source binding,
        while older implementation-specific fields remain untouched.
        """
        sources: list[dict[str, Any]] = []
        for input_spec in self.config.get("inputs", []):
            source_id = input_spec.get("sourceNodeId")
            if not source_id:
                continue
            source: dict[str, Any] = {
                "sourceNodeId": source_id,
                "sourcePoint": input_spec.get("sourcePoint", "out"),
            }
            for key in ("targetHandle", "label", "targetLabel"):
                if key in input_spec and input_spec[key] is not None:
                    source[key] = input_spec[key]
            sources.append(source)
        return {
            "observable_id": self.config["id"],
            "observable_name": self.config.get("name", self.config["id"]),
            "stereotype": self.config.get("stereotype", self.__class__.__name__),
            "execution_mode": context.mode,
            "epoch": context.epoch,
            "global_step": context.global_step,
            "batch_index": context.batch_index,
            "sources": sources,
            "timestamp": time.time(),
        }

    def finalize(self, context: CaptureContext) -> dict[str, Any] | None:
        """Produce a serializable result and reset phase-scoped state."""
        return self._finalize_mode(context.mode, context)

    def _finalize_mode(self, mode: str, context: CaptureContext) -> dict[str, Any] | None:
        raise NotImplementedError

    def clear(self) -> None:
        """Release captured tensors and transient rows."""
        for state in self._states.values():
            state.tensors.clear()
            state.rows.clear()
            state.count = 0
            state.seen = 0
        self._states.clear()
        self.state = self._state("EVAL")
