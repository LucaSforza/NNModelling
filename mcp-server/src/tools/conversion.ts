/*
 * NNModelling — DSL for designing neural networks via visual node editor
 * Copyright (C) 2026  Luca Sforza
 *
 * Licensed under the GNU General Public License v3 or later.
 * Commercial licenses are available — contact Luca Sforza.
 * See the LICENSE file for details.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 */

/**
 * Compilation, Serialization, and Pipeline Execution Tools.
 *
 * Diagram serialization remains a thin browser proxy. Package compilation
 * and training are owned by the authenticated backend API.
 *
 * @module tools/conversion
 */

import { z } from "zod";
import type { ServerContext } from "../server";

// ── Browser Proxy Tools ───────────────────────────────────────────────
export const export_diagram = {
  schema: z.object({}),

  async handler(ctx: ServerContext, _input: z.infer<typeof this.schema>) {
    return ctx.browser.call("export_diagram", {});
  },
};

export const import_diagram = {
  schema: z.object({ json: z.string().min(1) }),

  async handler(ctx: ServerContext, input: z.infer<typeof this.schema>) {
    return ctx.browser.call("import_diagram", input);
  },
};
