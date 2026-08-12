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

import { describe, it, expect, afterAll, afterEach } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { stubWindow, unstubWindow } from "../helpers";
import {
  loadManifest,
  getTargetDiagrams,
  tempDir,
  conditionalCleanup,
  runConvert,
  compileDiagramToFile,
  EXPECTED_YAML_FILES,
  type Tier,
  type NamedEntry,
} from "./helpers";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const manifest = loadManifest();
const tier = (process.env.NNM_TIER || "all") as Tier;
const shouldRun = tier === "all" || tier === "convert";

stubWindow();
afterAll(() => unstubWindow());

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

if (shouldRun) {
  const targets = getTargetDiagrams(manifest, "convert");

  describe.each(targets)("Convert: $name", ({ name, entry }: NamedEntry) => {
    const tmpDirs: string[] = [];

    afterEach(() => {
      for (const d of tmpDirs) {
        conditionalCleanup(d);
      }
    });

    it("convert.py produces valid Hydra config directory", { timeout: 120_000 }, () => {
      const workDir = tempDir();
      tmpDirs.push(workDir);
      const jsonPath = compileDiagramToFile(name, workDir);

      // Run convert.py with the manifest-declared dataset and class count so
      // the generated config matches the model's real training contract.
      const cfgDir = runConvert(jsonPath, {
        numClasses: entry.numClasses,
        dataset: entry.dataset,
      });

      // Verify expected YAML files exist
      for (const yamlFile of EXPECTED_YAML_FILES) {
        const yamlPath = resolve(cfgDir, yamlFile);
        expect(
          existsSync(yamlPath),
          `Expected ${yamlFile} to exist at ${yamlPath}`,
        ).toBe(true);
      }

      // The generated net config must reference the compiled NNTree root node
      // (file presence alone would accept a malformed conversion).
      const netYaml = readFileSync(resolve(cfgDir, "net", "custom_sequence.yaml"), "utf-8");
      const compiled = JSON.parse(readFileSync(jsonPath, "utf-8")) as { root: string };
      expect(netYaml).toContain(`root: ${compiled.root}`);

      // Classification models must carry the declared class count.
      if (entry.taskType === "classification") {
        expect(netYaml).toContain(`num_classes: ${entry.numClasses}`);
      }
    });

    it("convert.py honors the manifest dataset target", { timeout: 120_000 }, () => {
      const workDir = tempDir();
      tmpDirs.push(workDir);
      const jsonPath = compileDiagramToFile(name, workDir);

      const dataset = entry.dataset ?? "dataset.mnist.MNISTDataset";
      const cfgDir = runConvert(jsonPath, {
        numClasses: entry.numClasses,
        dataset,
      });

      const datasetYaml = readFileSync(resolve(cfgDir, "dataset", "dataset.yaml"), "utf-8");
      expect(datasetYaml).toContain(`_target_: ${dataset}`);
    });

    it("convert.py accepts the --dataset option", { timeout: 120_000 }, () => {
      const workDir = tempDir();
      tmpDirs.push(workDir);
      const jsonPath = compileDiagramToFile(name, workDir);

      // Explicit --dataset option (manifest dataset or the MNIST default).
      const cfgDir = runConvert(jsonPath, {
        numClasses: entry.numClasses,
        dataset: entry.dataset ?? "dataset.mnist.MNISTDataset",
      });

      // Verify base.yaml exists
      expect(existsSync(resolve(cfgDir, "base.yaml"))).toBe(true);
    });

    it(
      "convert.py accepts a structurally invalid NNTree (documented defect)",
      { timeout: 120_000 },
      () => {
        // Characterization of CURRENT behavior — do not fix, see bug table.
        //
        // Intended contract (docs/archive/completed-plans/code-elision/plan.md §T5): a
        // structurally invalid NNTree must not silently produce an
        // apparently-valid configuration. Current convert.py returns exit 0
        // and emits config files for `{"not": "valid nntree"}`. This test pins
        // the current behavior so elision work cannot change it unnoticed; the
        // defect is tracked as unresolved-design (backend/convert.py is out of
        // scope for this milestone's frontend task).
        const workDir = tempDir();
        tmpDirs.push(workDir);
        const incompleteJsonPath = join(workDir, "incomplete.json");
        writeFileSync(
          incompleteJsonPath,
          '{"not": "valid nntree"}',
          "utf-8",
        );

        let cfgDir: string;
        expect(() => {
          cfgDir = runConvert(incompleteJsonPath);
        }).not.toThrow();

        // Evidence of the defect: config output is produced for invalid input.
        expect(existsSync(resolve(cfgDir, "base.yaml"))).toBe(true);
      },
    );
  });
} else {
  describe.skip("Convert tier disabled", () => {
    it("runs only when NNM_TIER is convert or all", () => {});
  });
}
