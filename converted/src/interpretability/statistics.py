"""Streaming activation statistics."""

from __future__ import annotations

from typing import Any

import torch

from interpretability.base import CaptureContext, Observable


class ActivationStatistics(Observable):
    """Compute count, mean, variance, norm and sparsity without retaining tensors."""

    def __init__(self, config: dict[str, Any], publisher: Any) -> None:
        super().__init__(config, publisher)
        self._aggregates: dict[str, list[float]] = {}
        self._aggregate_contexts: dict[str, CaptureContext] = {}
        self._pending: dict[str, list[dict[str, Any]]] = {}

    def capture(self, value: torch.Tensor, context: CaptureContext, source: str) -> None:
        if not torch.is_tensor(value):
            return
        values = value.detach().float()
        aggregate = self._aggregates.setdefault(context.mode, [0.0, 0.0, 0.0, 0.0])
        aggregate[0] += values.sum().item()
        aggregate[1] += values.square().sum().item()
        aggregate[2] += values.eq(0).sum().item()
        aggregate[3] += values.numel()
        # Keep the context belonging to the captured mode.  The manager may
        # finalize this bucket after Lightning has switched to EVAL.
        self._aggregate_contexts[context.mode] = CaptureContext(
            context.mode, context.epoch, context.global_step, context.batch_index
        )

    def _finalize_mode(self, mode: str, context: CaptureContext) -> dict[str, Any] | None:
        self.seal_window("FINALIZE", context)
        rows = self._pending.pop(mode, [])
        if not rows:
            return None
        # Direct callers retain the historical single-row result shape.  The
        # manager uses finalize_all below when a mode has multiple windows.
        table_name = self.config.get("wandb_table_name") or f"observable/{self.config['id']}"
        self.publisher.publish(self.config["id"], table_name, rows)
        return rows[-1] if len(rows) == 1 else {"observable_id": self.config["id"], "rows": rows}

    def _make_row(self, mode: str, aggregate: list[float], context: CaptureContext) -> dict[str, Any] | None:
        total, sum_sq, zero_count, count = aggregate
        if not count:
            return None
        mean = total / count
        variance = max(0.0, sum_sq / count - mean * mean)
        row = self.common_result_metadata(
            CaptureContext(mode, context.epoch, context.global_step, context.batch_index)
        )
        row.update({
            "count": count,
            "sample_count": count,
            "mean": mean,
            "variance": variance,
            "norm": sum_sq**0.5,
            "sparsity": zero_count / count,
        })
        return row
    def seal_window(self, scope: str, context: CaptureContext) -> None:
        """Move streaming aggregates to lightweight pending window rows."""
        for mode, aggregate in list(self._aggregates.items()):
            row = self._make_row(mode, aggregate, self._aggregate_contexts.get(mode, context))
            if row is not None:
                self._pending.setdefault(mode, []).append(row)
            self._aggregates.pop(mode, None)
            self._aggregate_contexts.pop(mode, None)

    def finalize_all(self, context: CaptureContext) -> list[dict[str, Any]]:
        """Finalize every streaming mode bucket, including buckets without tensors."""
        self.seal_window("FINALIZE", context)
        results = []
        for mode in list(self._pending):
            rows = self._pending.pop(mode)
            if not rows:
                continue
            table_name = self.config.get("wandb_table_name") or f"observable/{self.config['id']}"
            self.publisher.publish(self.config["id"], table_name, rows)
            results.append(rows[-1] if len(rows) == 1 else {"observable_id": self.config["id"], "rows": rows})
        return results

    def begin_scope(self) -> None:
        super().begin_scope()
        self._aggregates.clear()
        self._aggregate_contexts.clear()
        self._pending.clear()

    def reset_retention(self, scope: str) -> None:
        super().reset_retention(scope)
        if self.config.get("retentionScope") in {scope, "LAST"}:
            self._aggregates.clear()
            self._aggregate_contexts.clear()

    def clear(self) -> None:
        super().clear()
        self._aggregates.clear()
        self._aggregate_contexts.clear()
        self._pending.clear()
