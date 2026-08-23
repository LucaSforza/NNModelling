"""Training execution backends."""

from backend.executors.base import Executor
from backend.executors.container import ContainerExecutor
from backend.executors.local import LocalExecutor
from backend.executors.slurm import SlurmExecutor

__all__ = ["ContainerExecutor", "Executor", "LocalExecutor", "SlurmExecutor"]
