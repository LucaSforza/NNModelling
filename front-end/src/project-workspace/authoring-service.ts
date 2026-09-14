import type { ModelPackageReference } from "../core/types"
import type { StereotypeAuthoringRequest } from "../stereotype-authoring"
import type {
  DatasetAuthoringRequest,
  GeneratedDatasetResources,
  ProjectDatasetAuthoringCoordinator,
} from "./dataset-authoring"
import type { ModelDatasetReference } from "./dataset-contract"
import type { ProjectStereotypeAuthoringCoordinator } from "./authoring"

/** The browser-owned operations shared by visible forms and browser RPC. */
export interface ProjectAuthoringOperations {
  createStereotype(request: StereotypeAuthoringRequest): Promise<ModelPackageReference>
  deleteStereotype(target: ModelPackageReference): Promise<ModelPackageReference>
  createDataset(request: DatasetAuthoringRequest): Promise<ModelDatasetReference>
  deleteDataset(target: ModelDatasetReference): Promise<ModelDatasetReference>
}

export type ProjectAuthoringServiceEffects = {
  readonly installDataset: (generated: GeneratedDatasetResources) => void
  readonly removeDataset: (target: ModelDatasetReference) => void
}

type StereotypeCoordinator = Pick<ProjectStereotypeAuthoringCoordinator, "author" | "delete">
type DatasetCoordinator = Pick<ProjectDatasetAuthoringCoordinator, "author" | "update" | "delete">

/**
 * Routes every authoring entry point through the project's existing
 * coordinators, then keeps the browser's training and inference catalogs in
 * step with successful dataset transactions.
 */
export class ProjectAuthoringService implements ProjectAuthoringOperations {
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly stereotypes: StereotypeCoordinator,
    private readonly datasets: DatasetCoordinator,
    private readonly effects: ProjectAuthoringServiceEffects,
  ) {}

  createStereotype(request: StereotypeAuthoringRequest): Promise<ModelPackageReference> {
    return this.serialize(async () => {
      const { generated } = await this.stereotypes.author(request)
      return generated.modelPackage
    })
  }

  deleteStereotype(target: ModelPackageReference): Promise<ModelPackageReference> {
    return this.serialize(() => this.stereotypes.delete(target))
  }

  createDataset(request: DatasetAuthoringRequest): Promise<ModelDatasetReference> {
    return this.serialize(async () => {
      const { generated } = await this.datasets.author(request)
      this.effects.installDataset(generated)
      return generated.modelDataset
    })
  }

  updateDataset(target: ModelDatasetReference, request: DatasetAuthoringRequest): Promise<void> {
    return this.serialize(async () => {
      const { generated } = await this.datasets.update(target, request)
      this.effects.installDataset(generated)
    })
  }

  deleteDataset(target: ModelDatasetReference): Promise<ModelDatasetReference> {
    return this.serialize(async () => {
      await this.datasets.delete(target)
      this.effects.removeDataset(target)
      return target
    })
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}
