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
 * Python Pipeline Interface
 *
 * Spawns Python subprocesses for conversion, training, and inference
 * using `uv run python` from the `converted/` working directory.
 *
 * @module pipeline
 */

import { spawn } from "child_process";
import { existsSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from "fs";
import { dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import {
  ConversionFailedError,
  TrainingFailedError,
  InferenceFailedError,
} from "./errors.js";

// ── Conversion Types ───────────────────────────────

export interface ConversionOptions {
  /** Output directory for generated Hydra YAML configs */
  outputDir: string;
  /** Number of classes (required for classification tasks) */
  numClasses?: number;
  /** Dataset class path (e.g. "dataset.mnist.MNISTDataset") */
  dataset?: string;
  /** Early stopping patience (default: 3) */
  earlyStopPatience?: number;
  /** Early stopping min delta (default: 0.0) */
  earlyStopMinDelta?: number;
  /** Max training epochs (default: 20) */
  maxEpochs?: number;
}

export interface ConversionResult {
  success: boolean;
  outputDir: string;
  taskType: string;
  numClasses: number | null;
  configFiles: string[];
}

// ── Training Types ─────────────────────────────────

export interface TrainingOptions {
  /** Path to the config directory (containing base.yaml etc.) */
  configDir: string;
  /** Config name (default: "base") */
  configName?: string;
  /** Device to use (default: cpu — only cpu/gpu supported) */
  device?: "cpu" | "gpu";
  /** Max training epochs (overrides config if set) */
  maxEpochs?: number;
}

export interface TrainingResult {
  success: boolean;
  /** Path to the saved weights checkpoint */
  checkpointPath: string | null;
  /** Parsed metrics from training stdout */
  metrics: { trainLoss?: number; valLoss?: number; valAccuracy?: number };
  /** Path to the wandb log directory */
  logPath: string;
  /** Training duration in seconds */
  duration: number;
}

// ── Inference Types ────────────────────────────────

export interface InferenceOptions {
  /** Path to the config directory */
  configDir: string;
  /** Config name (default: "base") */
  configName?: string;
  /** Path to the model weights checkpoint */
  weightsPath: string;
  /** Path to save predictions JSON */
  outputPath?: string;
  /** Directory to save image visualizations */
  imageDir?: string;
  /** Device (default: cpu) */
  device?: "cpu" | "gpu";
}

export interface InferenceResult {
  success: boolean;
  /** Path to the saved predictions JSON (null if not requested) */
  predictionsPath: string | null;
  /** Directory with saved image visualizations (null if not requested) */
  imageDir: string | null;
  /** Number of samples processed */
  sampleCount: number;
  /** Parsed metrics (e.g. test_loss, test_accuracy) */
  metrics: Record<string, number>;
}

// ── Helper: spawnPython ────────────────────────────

/**
 * Resolve the path to the `converted/` directory.
 *
 * Defaults to the repository sibling `converted/` directory. The module is
 * compiled either from `mcp-server/src/` or `mcp-server/dist/`, so this must
 * be resolved from the module URL rather than the invocation working folder.
 * It can be overridden via the `NNM_PYTHON_DIR` environment variable.
 */
function getConvertedDir(): string {
  const envDir = process.env.NNM_PYTHON_DIR;
  if (envDir) {
    return resolve(envDir);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "converted");
}

/**
 * Spawn a Python subprocess using `uv run python` from the `converted/`
 * working directory.
 *
 * @param args - Arguments to pass to the Python script
 * @returns Promise resolving with stdout, stderr, and exit code
 */
function spawnPython(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn("uv", ["run", "python", ...args], {
      cwd: getConvertedDir(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (exitCode) => {
      resolvePromise({ stdout, stderr, exitCode: exitCode ?? 1 });
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

// ── executeConversion ──────────────────────────────

/**
 * Deprecated NNTree-to-Hydra conversion pipeline.
 * Package jobs use the backend package runtime instead.
 *
 * Writes the NNTree JSON to a temporary file, runs `convert.py`,
 * parses the output for task type, and walks the output directory
 * to list generated YAML config files.
 *
 * @param nntreeJson - The NNTree JSON string
 * @param options - Conversion options
 * @returns Conversion result with task type and generated config files
 * @throws {ConversionFailedError} If the conversion subprocess fails
 */
export async function executeConversion(
  nntreeJson: string,
  options: ConversionOptions,
): Promise<ConversionResult> {
  // Write NNTree JSON to a temporary file
  const tmpDir = mkdtempSync(join(tmpdir(), "nnmodelling-convert-"));
  const jsonPath = join(tmpDir, "nntree.json");

  try {
    writeFileSync(jsonPath, nntreeJson, "utf-8");

    // Build CLI arguments for convert.py
    const args = ["src/convert.py", jsonPath, options.outputDir];

    if (options.numClasses !== undefined) {
      args.push("--num-classes", String(options.numClasses));
    }
    if (options.dataset) {
      args.push("--dataset", options.dataset);
    }
    if (options.earlyStopPatience !== undefined) {
      args.push("--early-stop-patience", String(options.earlyStopPatience));
    }
    if (options.earlyStopMinDelta !== undefined) {
      args.push("--early-stop-min-delta", String(options.earlyStopMinDelta));
    }
    if (options.maxEpochs !== undefined) {
      args.push("--max-epochs", String(options.maxEpochs));
    }

    const { stdout, stderr, exitCode } = await spawnPython(args);

    if (exitCode !== 0) {
      throw new ConversionFailedError(
        stderr || `convert.py exited with code ${exitCode}`,
      );
    }

    // Parse stdout for task type
    // convert.py prints: "Detected task type: classification" or "Detected task type: regression"
    const taskTypeMatch = stdout.match(/Detected task type: (\w+)/);
    let taskType = taskTypeMatch ? taskTypeMatch[1] : "unknown";
    try {
      const nntree = JSON.parse(nntreeJson) as {
        lossNode?: { taskType?: string };
      };
      taskType = nntree.lossNode?.taskType ?? taskType;
    } catch {
      // Conversion already validated the payload; retain the stdout fallback.
    }

    // Walk the output directory to list generated .yaml files
    const configFiles: string[] = [];
    function walkDir(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.name.endsWith(".yaml")) {
          configFiles.push(fullPath);
        }
      }
    }
    walkDir(options.outputDir);

    return {
      success: true,
      outputDir: options.outputDir,
      taskType,
      numClasses: options.numClasses ?? null,
      configFiles,
    };
  } finally {
    // Clean up the temporary directory
    try {
      rmSync(tmpDir, { recursive: true });
    } catch {
      // Ignore cleanup errors (temp dirs are managed by the OS)
    }
  }
}

// ── executeTraining ────────────────────────────────

export function buildTrainingArgs(
  options: TrainingOptions,
  runDir: string,
): string[] {
  const args = [
    "src/main.py",
    "--config-path",
    resolve(options.configDir),
    "--config-name",
    options.configName || "base",
  ];

  if (options.maxEpochs !== undefined) {
    args.push(`trainer.max_epochs=${options.maxEpochs}`);
  }
  if (options.device !== undefined) {
    args.push(`trainer.accelerator=${options.device}`);
    args.push("+trainer.devices=1");
  }

  args.push(`hydra.run.dir=${runDir}`);
  args.push("hydra.job.chdir=true");
  args.push(`+trainer.default_root_dir=${runDir}`);
  args.push("+trainer.enable_progress_bar=false");
  args.push("+wandb.mode=disabled");
  return args;
}

/**
 * Execute model training via `main.py`.
 *
 * Runs the Hydra-powered training entry point with the specified config
 * directory and name. Tracks duration and attempts to locate the
 * checkpoint file after training completes.
 *
 * @param options - Training options
 * @returns Training result with checkpoint path, metrics, and duration
 * @throws {TrainingFailedError} If the training subprocess fails
 */
export async function executeTraining(
  options: TrainingOptions,
): Promise<TrainingResult> {
  const runDir = mkdtempSync(join(tmpdir(), "nnmodelling-training-"));
  const args = buildTrainingArgs(options, runDir);

  const startTime = Date.now();
  const { stdout, stderr, exitCode } = await spawnPython(args);
  const duration = (Date.now() - startTime) / 1000;

  if (exitCode !== 0) {
    throw new TrainingFailedError(
      stderr || `main.py exited with code ${exitCode}`,
    );
  }

  const weightsPath = join(runDir, "weights.pt");
  const checkpointPath = existsSync(weightsPath) ? weightsPath : null;

  // Attempt to parse metrics from stdout
  // Expected patterns: "val_metric: 0.98", "train_loss: 0.123"
  const metrics: {
    trainLoss?: number;
    valLoss?: number;
    valAccuracy?: number;
  } = {};

  // Look for final metric values reported by the Trainer
  const trainLossMatch = stdout.match(/train_loss[_\s]*[:=]\s*([\d.]+)/i);
  if (trainLossMatch) metrics.trainLoss = parseFloat(trainLossMatch[1]);

  const valLossMatch = stdout.match(/val_loss[_\s]*[:=]\s*([\d.]+)/i);
  if (valLossMatch) metrics.valLoss = parseFloat(valLossMatch[1]);

  const valAccMatch = stdout.match(/val_metric[_\s]*[:=]\s*([\d.]+)/i);
  if (valAccMatch) metrics.valAccuracy = parseFloat(valAccMatch[1]);

  return {
    success: true,
    checkpointPath,
    metrics,
    logPath: runDir,
    duration,
  };
}

// ── executeInference ───────────────────────────────

/**
 * Execute model inference via `infer.py`.
 *
 * Runs the inference script with the given config, weights, and optional
 * output/image directories. Parses sample count and metrics from stdout.
 *
 * @param options - Inference options
 * @returns Inference result with predictions path, sample count, and metrics
 * @throws {InferenceFailedError} If the inference subprocess fails
 */
export async function executeInference(
  options: InferenceOptions,
): Promise<InferenceResult> {
  const absConfigDir = resolve(options.configDir);
  const absWeightsPath = resolve(options.weightsPath);

  const args = [
    "src/infer.py",
    "--config-path",
    absConfigDir,
    "--config-name",
    options.configName || "base",
    "--weights",
    absWeightsPath,
  ];

  if (options.outputPath) {
    args.push("--output", resolve(options.outputPath));
  }
  if (options.imageDir) {
    args.push("--image-dir", resolve(options.imageDir));
  }
  if (options.device) {
    args.push("--device", options.device);
  }

  const { stdout, stderr, exitCode } = await spawnPython(args);

  if (exitCode !== 0) {
    throw new InferenceFailedError(
      stderr || `infer.py exited with code ${exitCode}`,
    );
  }

  // Parse sample count from stdout
  // infer.py prints: "Saved N predictions to ..."
  const sampleCountMatch = stdout.match(/Saved (\d+) predictions/);
  const sampleCount = sampleCountMatch
    ? parseInt(sampleCountMatch[1], 10)
    : 0;

  // Parse metrics from stdout
  // infer.py uses the Lightning Trainer which prints:
  //   "test_loss: 0.123456"
  //   "test_accuracy: 0.987654"
  const metrics: Record<string, number> = {};
  const metricLineRegex = /^\s*(test_\w+|val_\w+|train_\w+)\s*[:=]\s*([\d.\-]+)/gm;
  let metricMatch: RegExpExecArray | null;
  while ((metricMatch = metricLineRegex.exec(stdout)) !== null) {
    const value = parseFloat(metricMatch[2]);
    if (!isNaN(value)) {
      metrics[metricMatch[1]] = value;
    }
  }
  // Also match results block: "  test_loss: 0.123456"
  const resultBlockRegex = /Results:[\s\S]*?(?=\n\n|\n$|$)/g;
  const resultBlock = resultBlockRegex.exec(stdout);
  if (resultBlock) {
    const resultMetricRegex = /(\w+):\s+([\d.]+)/g;
    let rm: RegExpExecArray | null;
    while ((rm = resultMetricRegex.exec(resultBlock[0])) !== null) {
      const value = parseFloat(rm[2]);
      if (!isNaN(value)) {
        metrics[rm[1]] = value;
      }
    }
  }

  return {
    success: true,
    predictionsPath: options.outputPath ?? null,
    imageDir: options.imageDir ?? null,
    sampleCount,
    metrics,
  };
}
