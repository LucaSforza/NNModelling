# Current internal knowledge

These documents describe NNModelling as it exists now. Update them when code
changes their contracts; do not append implementation history.

## Architecture

- [System overview](architecture/overview.md)
- [Browser-backed MCP](architecture/browser-mcp.md)
- [Remote training](architecture/remote-training.md)

## Contracts

- [NNTree](contracts/nntree.md)
- [Tensor types](contracts/tensor-types.md)
- [Pairing and ownership](contracts/pairing.md)
- [Portable model packages](contracts/model-package.md)

## Verification and operation

- [Testing strategy](testing/strategy.md)
- [Local development stack](operations/local-stack.md)

Durable architectural decisions should be added under `decisions/` and linked
from the affected contract. Historical reasoning belongs under `docs/archive/`.
