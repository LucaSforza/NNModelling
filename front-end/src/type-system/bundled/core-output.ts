import manifest from "../../../../stereotype-packages/core/output/manifest.json?raw"
import definition from "../../../../stereotype-packages/core/output/stereotype.json?raw"
import inference from "../../../../stereotype-packages/core/output/inference.lua?raw"
import pytorch from "../../../../stereotype-packages/core/output/pytorch.py?raw"
import type { PackageSelection } from "../host"

export const coreOutputPackage: PackageSelection = {
  directory: "stereotype-packages/core/output",
  resources: {
    "manifest.json": manifest,
    "stereotype.json": definition,
    "inference.lua": inference,
    "pytorch.py": pytorch,
  },
}
