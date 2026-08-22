import manifest from "../../../../stereotype-packages/core/input/manifest.json?raw"
import definition from "../../../../stereotype-packages/core/input/stereotype.json?raw"
import inference from "../../../../stereotype-packages/core/input/inference.lua?raw"

import type { PackageSelection } from "../host"

/** Explicit browser delivery for the first bundled standard-library package. */
export const coreInputPackage: PackageSelection = {
  directory: "stereotype-packages/core/input",
  resources: {
    "manifest.json": manifest,
    "stereotype.json": definition,
    "inference.lua": inference,
  },
}
