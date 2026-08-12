# Phase 5: Clean up errors.ts

## Objective
Remove unused error classes. Only pipeline errors + base class are needed since validation errors are now handled by BrowserRPCHandler and propagated as plain Error messages via RPC.

## Files

| File | Action |
|---|---|
| `mcp-server/src/errors.ts` | **REWRITE** — keep 6 classes, remove 16 |
| `mcp-server/src/tools/conversion.ts` | **CHECK** — update imports if using deleted errors |

## Error Classes to KEEP

```typescript
export class MCPServerError extends Error { ... }  // base
export class CompilationFailedError extends MCPServerError { ... }
export class ConversionFailedError extends MCPServerError { ... }
export class TrainingFailedError extends MCPServerError { ... }
export class InferenceFailedError extends MCPServerError { ... }
```

## Error Classes to REMOVE

All validation errors:
- StereotypeNotFoundError, NodeNotFoundError, EdgeNotFoundError
- ParameterNotFoundError, ParameterTypeMismatchError
- TargetHandleOccupiedError, InvalidConnectionError, SelfLoopError
- CycleDetectedError, InvalidPositionError, InvalidSubflowError

All transaction/history/serialization errors:
- NoActiveTransactionError, TransactionAlreadyActiveError
- NothingToUndoError, NothingToRedoError
- ImportFailedError, ExportFailedError

## Import Fixes

Check `tools/conversion.ts` — it imports `CompilationFailedError`, `ImportFailedError`, `ExportFailedError`. Remove `ImportFailedError` and `ExportFailedError` imports (replace with plain `Error` throws).

## Verification
```bash
cd mcp-server && npx tsc --noEmit
```
