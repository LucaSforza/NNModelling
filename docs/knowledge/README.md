# Current internal knowledge

These documents describe NNModelling as it exists now. Update them when code
changes their contracts; do not append implementation history.

## Architecture

- [System overview](architecture/overview.md)
- [Browser-backed MCP](architecture/browser-mcp.md)
- [Remote training](architecture/remote-training.md)

## Contracts

- [Frontend package type system](contracts/package-type-system.md)
- [Pairing and ownership](contracts/pairing.md)
- [Portable model packages](contracts/model-package.md)

## Verification and operation

- [Testing strategy](testing/strategy.md)
- [Local development stack](operations/local-stack.md)

Durable architectural decisions should be added under `decisions/` and linked
from the affected contract. Historical reasoning belongs under `docs/archive/`.

Current decisions:

- [Package type-system cutover](decisions/stereotype-type-system-migration.md)
- [Editable edge routing](decisions/editable-edge-routing.md)
- [Package backend standard and least-privilege execution](decisions/package-backend-standard.md)
- [Prediction and objective program separation](decisions/prediction-objective-programs.md)
- [Declarative wheel adapters](decisions/wheel-adapters.md)
