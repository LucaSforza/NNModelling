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
 * Three patterns:
 *   1. Browser proxy: compile_nntree, export_diagram, import_diagram
 *   2. Hybrid: execute_conversion queries browser for NNTree JSON, then runs
 *      convert.py on the server side
 *   3. Server-only pipeline: execute_training, execute_inference
 *
 * @module tools/conversion
 */

import { z } from "zod";
import type { ServerContext } from "../server";
import type { ConversionResult, TrainingResult, InferenceResult } from "../pipeline";

// ── Browser Proxy Tools ───────────────────────────────────────────────

// DEPRECATED: NNTree conversion remains for MCP compatibility while package
// export and backend execution become the forward workflow.
export const compile_nntree = {
  schema: z.object({}),

  async handler(ctx: ServerContext, _input: z.infer<typeof this.schema>) {
    return ctx.browser.call("compile_nntree", {});
  },
};

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

// ── Hybrid Pipeline Tools ────────────────────────────────────────────

/**
 * execute_conversion: queries browser for NNTree JSON, writes temp file,
 * runs convert.py via server-side pipeline.
 */
export const execute_conversion = {
  schema: z.object({
    outputDir: z.string().min(1),
    numClasses: z.number().int().positive().optional(),
    dataset: z.string().optional(),
    earlyStopPatience: z.number().int().nonnegative().optional(),
    earlyStopMinDelta: z.number().nonnegative().optional(),
    maxEpochs: z.number().int().positive().optional(),
  }),

  async handler(
    ctx: ServerContext,
    input: z.infer<typeof this.schema>,
  ): Promise<ConversionResult> {
    // Step 1: Compile NNTree on the browser side
    const nntreeOutput = await ctx.browser.call<{ json: string }>("compile_nntree", {});

    // Step 2: Run Python conversion on the server side
    const result = await ctx.pipeline.executeConversion(nntreeOutput.json, {
      outputDir: input.outputDir,
      numClasses: input.numClasses,
      dataset: input.dataset,
      earlyStopPatience: input.earlyStopPatience,
      earlyStopMinDelta: input.earlyStopMinDelta,
      maxEpochs: input.maxEpochs,
    });

    return result;
  },
};

// ── Server-Only Pipeline Tools ────────────────────────────────────────

export const execute_training = {
  schema: z.object({
    configDir: z.string().min(1),
    configName: z.string().optional(),
    device: z.enum(["cpu", "gpu"]).optional(),
    maxEpochs: z.number().int().positive().optional(),
  }),

  async handler(
    ctx: ServerContext,
    input: z.infer<typeof this.schema>,
  ): Promise<TrainingResult> {
    return ctx.pipeline.executeTraining({
      configDir: input.configDir,
      configName: input.configName,
      device: input.device,
      maxEpochs: input.maxEpochs,
    });
  },
};

export const execute_inference = {
  schema: z.object({
    configDir: z.string().min(1),
    configName: z.string().optional(),
    weightsPath: z.string().min(1),
    outputPath: z.string().optional(),
    imageDir: z.string().optional(),
    device: z.enum(["cpu", "gpu"]).optional(),
  }),

  async handler(
    ctx: ServerContext,
    input: z.infer<typeof this.schema>,
  ): Promise<InferenceResult> {
    return ctx.pipeline.executeInference({
      configDir: input.configDir,
      configName: input.configName,
      weightsPath: input.weightsPath,
      outputPath: input.outputPath,
      imageDir: input.imageDir,
      device: input.device,
    });
  },
};
