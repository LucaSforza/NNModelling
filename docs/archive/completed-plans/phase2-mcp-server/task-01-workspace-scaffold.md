# Task 0+1: pnpm Workspace + mcp-server Package Scaffold

**Type**: Backend  
**Design Ref**: `docs/archive/superseded/mcp-server-architecture/phase2-mcp-server.md` Steps 0-1

## Objective
Set up monorepo workspace structure with pnpm and scaffold the `mcp-server/` package with all dependencies.

## Files to Create

### 1. `pnpm-workspace.yaml` (repo root)
```yaml
packages:
  - "front-end"
  - "mcp-server"
```

### 2. `mcp-server/package.json`
- Name: `@nnmodelling/mcp-server`
- Type: module
- Dependencies: `@modelcontextprotocol/sdk: ^1.0.0`, `@nnmodelling/front-end: workspace:*`, `ws: ^8.18.0`, `zod: ^3.23.0`
- DevDependencies: `@types/node: ^22.0.0`, `@types/ws: ^8.5.0`, `typescript: ^5.8.0`, `vitest: ^4.1.0`
- Scripts: build (tsc), dev (tsc --watch), test (vitest run), test:watch (vitest), start (node dist/index.js)

### 3. `mcp-server/tsconfig.json`
- target: ES2022, module: ESNext, moduleResolution: bundler
- outDir: ./dist, rootDir: ./src
- strict: true, esModuleInterop: true, skipLibCheck: true
- resolveJsonModule: true, declaration: true, sourceMap: true
- include: src/**/*.ts, exclude: node_modules, dist, __tests__

### 4. `mcp-server/vitest.config.ts`
```typescript
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
    globals: true,
    testTimeout: 30_000,
  },
});
```

## Files to Modify

### 5. `front-end/package.json`
- Change `"name"` from `"vite-svelte-flow-template"` to `"@nnmodelling/front-end"`
- Add `"exports"` field mapping `"./core/*"` to `"./src/core/*"`

## Verification
1. `pnpm install` from repo root resolves both packages
2. `cd mcp-server && pnpm run build` compiles (empty src/ is OK)
3. No existing tests broken

## Commit
`git add pnpm-workspace.yaml mcp-server/ front-end/package.json && git commit -m "chore: add pnpm workspace + scaffold mcp-server package"`
