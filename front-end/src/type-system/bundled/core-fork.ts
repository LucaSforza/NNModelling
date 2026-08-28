import manifest from "../../../../stereotype-packages/core/fork/manifest.json?raw"
import definition from "../../../../stereotype-packages/core/fork/stereotype.json?raw"
import inference from "../../../../stereotype-packages/core/fork/inference.lua?raw"
import type { PackageSelection } from "../host"

export const coreForkPackage: PackageSelection = {
  directory: "stereotype-packages/core/fork",
  resources: {
    "manifest.json": manifest,
    "stereotype.json": definition,
    "inference.lua": inference,
  },
}
