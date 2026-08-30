import { z } from "zod"
import type { ServerContext } from "../server.js"
import { validateProjectPath } from "../project-path.js"

const projectPath = z.string().min(1).describe("Absolute canonical project directory path")

/** Project lifecycle proxies. The browser remains responsible for activation and handles. */
export const create_project = {
  schema: z.object({
    projectPath,
    id: z.string().min(1),
    version: z.string().min(1).default("0.1.0"),
    name: z.string().min(1),
    description: z.string().optional(),
  }),
  async handler(ctx: ServerContext, input: { projectPath: string; id: string; version: string; name: string; description?: string }) {
    const safePath = validateProjectPath(input.projectPath, ctx.projectRoot)
    return ctx.browser.call("create_project", { ...input, projectPath: safePath })
  },
}

export const open_project = {
  schema: z.object({ projectPath }),
  async handler(ctx: ServerContext, input: { projectPath: string }) {
    const safePath = validateProjectPath(input.projectPath, ctx.projectRoot)
    return ctx.browser.call("open_project", { projectPath: safePath })
  },
}
