"""Training execution backends."""

from backend.executors.base import Executor
from backend.executors.container import ContainerExecutor

__all__ = ["ContainerExecutor", "Executor"]
