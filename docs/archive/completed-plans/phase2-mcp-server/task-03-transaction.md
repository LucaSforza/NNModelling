# Task 3: TransactionManager

**Type**: Backend  
**Design Ref**: `docs/archive/superseded/mcp-server-architecture/phase2-mcp-server.md` Step 3

## Objective
Implement the `TransactionManager` class that buffers mutations during a transaction and applies them atomically on commit, or discards them on rollback.

## Files to Create

### `mcp-server/src/transaction.ts`
Key interfaces and class:
- `BufferedMutation`: { type: string, execute: () => void, undo?: () => void }
- `Transaction`: { id: string, label: string, snapshot: DiagramCoreSnapshot, mutations: BufferedMutation[] }
- `TransactionManager` class:
  - `begin(label: string): string` - starts a new transaction, saves snapshot
  - `buffer(mutation: BufferedMutation): void` - if active tx, buffer it; otherwise execute immediately
  - `commit()` - apply all buffered mutations, return summary
  - `rollback()` - restore pre-transaction snapshot, discard mutations
  - `isActive(): boolean`
  - `getActiveId(): string | null`

Imports: DiagramCore from `@nnmodelling/front-end/core/DiagramCore`, error classes from `./errors`

## Verification
- `pnpm run build` in mcp-server compiles without errors
- Basic logic: begin captures snapshot, rollback restores state

## Commit
`git add mcp-server/src/transaction.ts && git commit -m "feat(mcp): implement TransactionManager"`
