<script lang="ts">
  import "../styles/package-manager.css";
  import DatasetForm from "./DatasetForm.svelte";
  import StereotypeForm from "./StereotypeForm.svelte";
  import type { DatasetAuthoringRequest, GeneratedDatasetResources } from "../project-workspace/dataset-authoring";
  import type { ModelDatasetReference } from "../project-workspace/dataset-contract";
  import type { InstalledPackageRecord } from "../type-system/packages/types";
  import type { StereotypeAuthoringRequest } from "../stereotype-authoring";
  import { useI18n } from "../i18n.svelte";

  export type PackageManagerPackage = Pick<InstalledPackageRecord, "key" | "source" | "definition">;

  interface Props {
    packages: readonly PackageManagerPackage[];
    onAuthoringRequest?: (request: StereotypeAuthoringRequest) => Promise<void> | void;
    projectDatasets?: readonly GeneratedDatasetResources[];
    onDatasetAuthoringRequest?: (request: DatasetAuthoringRequest) => Promise<void> | void;
    onDatasetUpdateRequest?: (target: ModelDatasetReference, request: DatasetAuthoringRequest) => Promise<void> | void;
    onDatasetDeleteRequest?: (target: ModelDatasetReference) => Promise<void> | void;
    /** Compatibility index until the canvas integration task removes old callers. */
    [key: string]: unknown;
  }

  let {
    packages,
    onAuthoringRequest,
    projectDatasets = [],
    onDatasetAuthoringRequest,
    onDatasetUpdateRequest,
    onDatasetDeleteRequest,
  }: Props = $props();
  const { t } = useI18n();
  let bundled = $derived(packages.filter((item) => item.source === "bundled"));
  let project = $derived(packages.filter((item) => item.source === "model"));
  let creationType = $state<"stereotype" | "dataset">("stereotype");
</script>

<section class="package-manager" aria-label={t("Package manager")}>
  <header class="package-manager__header">
    <div>
      <h2>Packages</h2>
      <p>{t("Packages are read-only at the core. Create project stereotypes or datasets below.")}</p>
    </div>
  </header>

  {#if project.length > 0}
    <div class="package-manager__group">
      <h3>{t("User packages")}</h3>
      {#each project as packageInfo (packageInfo.key)}
        <div class="package-manager__row">
          <span><strong>{packageInfo.definition.name}</strong><small>{packageInfo.key}</small></span>
          <em>{t("Project")}</em>
        </div>
      {/each}
    </div>
  {/if}

  <div class="package-manager__creation-picker">
    <h3 id="package-manager-creation-title">{t("Create new")}</h3>
    <div class="package-manager__creation-options" role="group" aria-labelledby="package-manager-creation-title">
      <button
        type="button"
        class={[
          "package-manager__creation-option",
          { "package-manager__creation-option--selected": creationType === "stereotype" },
        ]}
        aria-pressed={creationType === "stereotype"}
        onclick={() => (creationType = "stereotype")}
      >
        {t("Stereotype")}
      </button>
      <button
        type="button"
        class={[
          "package-manager__creation-option",
          { "package-manager__creation-option--selected": creationType === "dataset" },
        ]}
        aria-pressed={creationType === "dataset"}
        onclick={() => (creationType = "dataset")}
      >
        {t("Dataset")}
      </button>
    </div>
  </div>

  {#if creationType === "stereotype"}
    <StereotypeForm onAuthoringRequest={onAuthoringRequest} />
  {:else}
    <DatasetForm
      {projectDatasets}
      onAuthoringRequest={onDatasetAuthoringRequest}
      onUpdateRequest={onDatasetUpdateRequest}
      onDeleteRequest={onDatasetDeleteRequest}
    />
  {/if}

  <div class="package-manager__group">
    <h3>{t("Core")}</h3>
    {#if bundled.length === 0}<p class="package-manager__empty">{t("No core stereotypes.")}</p>{/if}
    {#each bundled as packageInfo (packageInfo.key)}
      <div class="package-manager__row">
        <span><strong>{packageInfo.definition.name}</strong><small>{packageInfo.key}</small></span>
        <em>{t("Read-only")}</em>
      </div>
    {/each}
  </div>
</section>
