# Task 2: Error Type Hierarchy

**Type**: Backend  
**Design Ref**: `docs/archive/superseded/mcp-server-architecture/phase2-mcp-server.md` Step 2

## Objective
Implement the error type hierarchy for the MCP server. All errors extend `MCPServerError` base class with machine-readable error codes.

## Files to Create

### `mcp-server/src/errors.ts`
Create all error classes with the `code`, `message`, `details` pattern:

Base class:
- `MCPServerError` - extends Error, has `code`, `details`, `toJSON()` method

Validation errors:
- `StereotypeNotFoundError` (code: STEREOTYPE_NOT_FOUND)
- `NodeNotFoundError` (code: NODE_NOT_FOUND)
- `EdgeNotFoundError` (code: EDGE_NOT_FOUND)
- `ParameterNotFoundError` (code: PARAMETER_NOT_FOUND)
- `ParameterTypeMismatchError` (code: PARAMETER_TYPE_MISMATCH)
- `TargetHandleOccupiedError` (code: TARGET_HANDLE_OCCUPIED)
- `InvalidConnectionError` (code: INVALID_CONNECTION)
- `SelfLoopError` (code: SELF_LOOP)
- `CycleDetectedError` (code: CYCLE_DETECTED)
- `InvalidPositionError` (code: INVALID_POSITION)
- `InvalidSubflowError` (code: INVALID_SUBFLOW)

Pipeline errors:
- `CompilationFailedError` (code: COMPILATION_FAILED)
- `ConversionFailedError` (code: CONVERSION_FAILED)
- `TrainingFailedError` (code: TRAINING_FAILED)
- `InferenceFailedError` (code: INFERENCE_FAILED)

Transaction errors:
- `NoActiveTransactionError` (code: NO_ACTIVE_TRANSACTION)
- `TransactionAlreadyActiveError` (code: TRANSACTION_ALREADY_ACTIVE)

History errors:
- `NothingToUndoError` (code: NOTHING_TO_UNDO)
- `NothingToRedoError` (code: NOTHING_TO_REDO)

Serialization errors:
- `ImportFailedError` (code: IMPORT_FAILED)
- `ExportFailedError` (code: EXPORT_FAILED)

## Verification
- `pnpm run build` in mcp-server compiles without errors

## Commit
`git add mcp-server/src/errors.ts && git commit -m "feat(mcp): implement error type hierarchy"`
