"""Local and optional W&B result publication."""

from __future__ import annotations

import json
import os
import warnings
import uuid
from pathlib import Path
from typing import Any


class ResultPublisher:
    """Publish one stable table per Observable, with a local fallback."""

    def __init__(
        self,
        run_root: str | None = None,
        experiment: Any = None,
        wandb_module: Any = None,
        run_id: str | None = None,
    ) -> None:
        """Create an isolated publisher for one execution.

        ``NNM_INTERPRETABILITY_ROOT`` configures the stable parent directory;
        every publisher gets a fresh child directory unless ``run_id`` is
        explicitly supplied.  The latter is useful when a caller needs to
        correlate metadata with an externally assigned job/run identifier.
        """
        root = run_root or os.environ.get("NNM_INTERPRETABILITY_ROOT") or ".interpretability"
        self.root_dir = Path(root)
        self.run_id = run_id or os.environ.get("NNM_INTERPRETABILITY_RUN_ID") or uuid.uuid4().hex
        self.run_dir = self.root_dir / self.run_id
        self.experiment = experiment
        self.wandb = wandb_module
        self.tables: dict[str, list[dict[str, Any]]] = {}
        self._table_keys: dict[str, str] = {}

    def publish(self, observable_id: str, table_name: str, rows: list[dict[str, Any]]) -> None:
        """Persist rows locally and best-effort log a W&B table."""
        if not rows:
            return
        self.run_dir.mkdir(parents=True, exist_ok=True)
        # The requested name is only a display hint.  Each Observable owns a
        # separate publication key even when names collide.
        publication_key = self._table_keys.setdefault(
            observable_id, f"observable/{observable_id}/{table_name.rsplit('/', 1)[-1]}"
        )
        self.tables.setdefault(observable_id, []).extend(rows)
        local_path = self.result_path(observable_id)
        local_path.write_text(json.dumps(self.tables[observable_id], default=str, indent=2), encoding="utf-8")
        if self.experiment is None or self.wandb is None:
            return
        try:
            columns = sorted({key for row in self.tables[observable_id] for key in row})
            data = [[row.get(column) for column in columns] for row in self.tables[observable_id]]
            table = self.wandb.Table(columns=columns, data=data)
            self.experiment.log({publication_key: table})
        except Exception as error:  # W&B is explicitly non-critical.
                warnings.warn(f"Unable to publish Observable {observable_id} to W&B: {error}", RuntimeWarning)

    def result_path(self, observable_id: str) -> Path:
        """Return the concrete metadata path for an Observable in this run."""
        return self.run_dir / f"{observable_id}.json"

    def save_tensor(self, observable_id: str, index: int, tensor: Any) -> str:
        """Write a tensor artifact locally and return its reference."""
        path = self.run_dir / f"{observable_id}_{index:05d}_{uuid.uuid4().hex}.pt"
        self.run_dir.mkdir(parents=True, exist_ok=True)
        import torch

        torch.save(tensor, path)
        return str(path)

    def clear_transient(self) -> None:
        """Drop in-memory publication state while preserving durable output.

        The local JSON files and tensor artifacts are the durable publication
        boundary.  Rows, publication keys, and the logger handles are only
        needed while a run is active and must not become part of a pickled
        model.
        """
        self.tables.clear()
        self._table_keys.clear()
        self.experiment = None
        self.wandb = None
