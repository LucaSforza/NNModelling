"""ActivationRecorder implementation."""

from __future__ import annotations

from typing import Any

import torch

from interpretability.base import CaptureContext, Observable


class ActivationRecorder(Observable):
    """Sample forward values and publish metadata plus local tensor references."""

    def capture(self, value: torch.Tensor, context: CaptureContext, source: str) -> None:
        if not torch.is_tensor(value):
            return
        state = self._state(context.mode)
        sampled = self.config.get("storageStrategy") == "SAMPLED"
        every = max(1, int(self.config.get("sample_every", 1))) if sampled else 1
        if state.seen % every:
            state.seen += 1
            return
        state.seen += 1
        limit = max(0, int(self.config.get("max_samples", 128))) if sampled else None
        if limit is not None and len(state.tensors) >= limit:
            return
        if self.config.get("retentionScope") == "LAST":
            state.tensors.clear()
            state.rows.clear()
        tensor = value.detach() if self.config.get("detach", True) else value
        if self.config.get("move_to_cpu", True):
            tensor = tensor.cpu()
        state.tensors.append(tensor)
        state.rows.append({"source": source, "context": context})

    def __init__(self, config: dict[str, Any], publisher: Any) -> None:
        super().__init__(config, publisher)
        self._pending: dict[str, list[dict[str, Any]]] = {}

    def seal_window(self, scope: str, context: CaptureContext) -> None:
        """Persist tensor artifacts while retaining only lightweight rows."""
        for mode, state in list(self._states.items()):
            if not state.tensors:
                continue
            pending = self._pending.setdefault(mode, [])
            for index, (tensor, source_row) in enumerate(zip(state.tensors, state.rows)):
                row_context = source_row["context"]
                row = self.common_result_metadata(row_context)
                row.update({
                    "source": source_row["source"],
                    "sample_count": len(state.tensors),
                    "artifact": self.publisher.save_tensor(self.config["id"], index, tensor),
                    "shape": list(tensor.shape),
                    "dtype": str(tensor.dtype),
                    "size": tensor.numel(),
                })
                pending.append(row)
            state.tensors.clear()
            state.rows.clear()
            state.count = state.seen = 0

    def _finalize_mode(self, mode: str, context: CaptureContext) -> dict[str, Any] | None:
        state = self._state(mode)
        self.seal_window("FINALIZE", context)
        rows = self._pending.pop(mode, [])
        if not rows:
            return None
        table_name = self.config.get("wandb_table_name") or f"observable/{self.config['id']}"
        self.publisher.publish(self.config["id"], table_name, rows)
        result = {"kind": "tensor_reference", "rows": rows}
        self._states.pop(mode, None)
        return result

    def begin_scope(self) -> None:
        super().begin_scope()
        self._pending.clear()

    def clear(self) -> None:
        super().clear()
        self._pending.clear()
