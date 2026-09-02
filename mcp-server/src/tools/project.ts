import { z } from "zod"
import type { ServerContext } from "../server.js"
import { createProjectAtPath, openProjectAtPath, rollbackCreatedProject } from "../project-path.js"

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
    const payload = await createProjectAtPath(input.projectPath, ctx.projectRoot, input)
    let result: unknown
    try {
      result = await ctx.browser.call("create_project", payload)
    } catch (error) {
      await rollbackCreatedProject(payload.projectPath, ctx.projectRoot).catch(() => undefined)
      throw error
    }
    const tabId = ctx.browser.getActiveTabId()
    if (tabId) ctx.projectPaths.set(tabId, payload.projectPath)
    return result
  },
}

export const open_project = {
  schema: z.object({ projectPath }),
  async handler(ctx: ServerContext, input: { projectPath: string }) {
    const payload = await openProjectAtPath(input.projectPath, ctx.projectRoot)
    const result = await ctx.browser.call("open_project", payload)
    const tabId = ctx.browser.getActiveTabId()
    if (tabId) ctx.projectPaths.set(tabId, payload.projectPath)
    return result
  },
}
