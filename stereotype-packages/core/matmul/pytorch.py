from typing import TypedDict

import torch

from stereotype_runtime.pytorch import BuildContext, NoServices


class Parameters(TypedDict):
    pass


class SequentialMatMul(torch.nn.Module):
    """Use PyTorch's optimal matrix-chain multiplication for short joins."""

    def forward(self, *inputs: torch.Tensor) -> torch.Tensor:
        if len(inputs) < 2:
            raise ValueError("MatMul expects at least 2 inputs")
        return torch.linalg.multi_dot(inputs)


class ParallelMatMul(torch.nn.Module):
    """Evaluate an optimal matrix chain with independent CUDA subtrees overlapped."""

    def __init__(self, input_count: int) -> None:
        super().__init__()
        self.input_count = input_count
        self._streams_by_device = {}

    def forward(self, *inputs: torch.Tensor) -> torch.Tensor:
        if len(inputs) != self.input_count:
            raise ValueError(f"MatMul expected {self.input_count} inputs, got {len(inputs)}")
        if inputs[0].device.type != "cuda":
            return torch.linalg.multi_dot(inputs)

        plan = _optimal_plan(inputs)
        streams = self._streams_for(inputs[0].device)
        cursor = [0]
        output, event = self._schedule(plan, inputs, streams, cursor)
        torch.cuda.current_stream(inputs[0].device).wait_event(event)
        return output

    def _streams_for(self, device: torch.device):
        key = str(device)
        streams = self._streams_by_device.get(key)
        if streams is None:
            streams = [torch.cuda.Stream(device=device) for _ in range(self.input_count - 1)]
            self._streams_by_device[key] = streams
        return streams

    def _schedule(self, plan, inputs, streams, cursor):
        if isinstance(plan, int):
            return inputs[plan], None

        left, left_event = self._schedule(plan[0], inputs, streams, cursor)
        right, right_event = self._schedule(plan[1], inputs, streams, cursor)
        stream = streams[cursor[0]]
        cursor[0] += 1
        current_stream = torch.cuda.current_stream(inputs[0].device)
        stream.wait_stream(current_stream)
        if left_event is not None:
            stream.wait_event(left_event)
        if right_event is not None:
            stream.wait_event(right_event)
        with torch.cuda.stream(stream):
            output = torch.matmul(left, right)
        event = torch.cuda.Event()
        event.record(stream)
        return output, event


def _optimal_plan(inputs: tuple[torch.Tensor, ...]):
    """Choose the least-cost association while retaining matrix-chain order."""

    dimensions = [int(inputs[0].shape[0])]
    dimensions.extend(int(input_tensor.shape[1]) for input_tensor in inputs)
    count = len(inputs)
    costs = {}
    plans = {}

    for length in range(2, count + 1):
        for start in range(count - length + 1):
            end = start + length - 1
            best_cost = float("inf")
            best_plan = None
            for split in range(start, end):
                left_cost = costs.get((start, split), 0)
                right_cost = costs.get((split + 1, end), 0)
                cost = (
                    left_cost
                    + right_cost
                    + dimensions[start] * dimensions[split + 1] * dimensions[end + 1]
                )
                if cost < best_cost:
                    best_cost = cost
                    best_plan = (
                        plans.get((start, split), start),
                        plans.get((split + 1, end), end),
                    )
            costs[(start, end)] = best_cost
            plans[(start, end)] = best_plan

    return plans[(0, count - 1)]


def build(
    parameters: Parameters,
    context: BuildContext,
    services: NoServices,
) -> torch.nn.Module:
    input_count = context.get("inputs", 0)
    if input_count < 2:
        raise ValueError("MatMul expects at least 2 inputs")
    if input_count < 4:
        return SequentialMatMul()
    return ParallelMatMul(input_count)
