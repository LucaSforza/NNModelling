<script lang="ts">
  import "../styles/package-manager.css";
  import StereotypeForm from "./StereotypeForm.svelte";
  import type { InstalledPackageRecord } from "../type-system/packages/types";
  import type { StereotypeAuthoringRequest } from "../stereotype-authoring";

  export type PackageManagerPackage = Pick<InstalledPackageRecord, "key" | "source" | "definition">;

  interface Props {
    packages: readonly PackageManagerPackage[];
    onAuthoringRequest?: (request: StereotypeAuthoringRequest) => Promise<void> | void;
    /** Compatibility index until the canvas integration task removes old callers. */
    [key: string]: unknown;
  }

  let { packages, onAuthoringRequest }: Props = $props();
  let bundled = $derived(packages.filter((item) => item.source === "bundled"));
  let project = $derived(packages.filter((item) => item.source === "model"));
</script>

<section class="package-manager" aria-label="Stereotype manager">
  <header class="package-manager__header">
    <div>
      <h2>Stereotypes</h2>
      <p>Core stereotypes are read-only. Author new stereotypes for the active project below.</p>
    </div>
  </header>

  <div class="package-manager__group">
    <h3>Core</h3>
    {#if bundled.length === 0}<p class="package-manager__empty">No core stereotypes.</p>{/if}
    {#each bundled as packageInfo (packageInfo.key)}
      <div class="package-manager__row">
        <span><strong>{packageInfo.definition.name}</strong><small>{packageInfo.key}</small></span>
        <em>Read-only</em>
      </div>
    {/each}
  </div>

  <div class="package-manager__group">
    <h3>Current project</h3>
    {#if project.length === 0}<p class="package-manager__empty">No project stereotypes yet.</p>{/if}
    {#each project as packageInfo (packageInfo.key)}
      <div class="package-manager__row">
        <span><strong>{packageInfo.definition.name}</strong><small>{packageInfo.key}</small></span>
        <em>Project</em>
      </div>
    {/each}
  </div>

  <StereotypeForm onAuthoringRequest={onAuthoringRequest} />
</section>
