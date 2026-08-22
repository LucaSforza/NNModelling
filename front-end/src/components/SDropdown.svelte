<script lang="ts">
  import type { Diagram } from "../Diagram.svelte";
  import type { StereotypeCore } from "../core/StereotypeCore";
  import type { ActivePackageMetadata } from "../type-system/host";
  import { groupedPackages } from "../type-system/editor/package-ui";

  interface Props {
    diagram: Diagram;
    selectedStereotype?: StereotypeCore | null;
    onSelectedChange?: (stereotype: StereotypeCore | null) => void;
    packageCatalog?: readonly ActivePackageMetadata[];
    selectedPackage?: ActivePackageMetadata | null;
    onPackageChange?: (metadata: ActivePackageMetadata | null) => void;
  }

  let {
    diagram,
    selectedStereotype = null,
    onSelectedChange,
    packageCatalog = [],
    selectedPackage = null,
    onPackageChange,
  }: Props = $props();

  let packageMode = $derived(onPackageChange !== undefined || packageCatalog.length > 0);
  let packageGroups = $derived(groupedPackages(packageCatalog));

  function handleChange(event: Event) {
    const select = event.target as HTMLSelectElement;
    const value = select.value;
    if (packageMode) {
      const found = packageCatalog.find((metadata) => `${metadata.id}@${metadata.version}` === value);
      onPackageChange?.(found ?? null);
      return;
    }
    const found = diagram.stereotypes.find((stereotype) => stereotype.name === value);
    onSelectedChange?.(found ?? null);
  }
</script>

<select
  name={packageMode ? "packages" : "stereotypes"}
  id={packageMode ? "packages" : "stereotypes"}
  value={packageMode
    ? (selectedPackage ? `${selectedPackage.id}@${selectedPackage.version}` : "")
    : (selectedStereotype?.name ?? "")}
  onchange={handleChange}
>
  <option value="">{packageMode ? "-- aggiungi package --" : "-- aggiungi layer --"}</option>
  {#if packageMode}
    {#each packageGroups as group (group.name)}
      <optgroup label={group.name}>
        {#each group.packages as metadata (`${metadata.id}@${metadata.version}`)}
          <option value={`${metadata.id}@${metadata.version}`}>
            {metadata.definition.name}
          </option>
        {/each}
      </optgroup>
    {/each}
  {:else}
    {#each diagram.stereotypes as stereotype (stereotype.name)}
      <option value={stereotype.name}>{stereotype.name}</option>
    {/each}
  {/if}
</select>

<style>
  @import "../styles/dropdown.css";
</style>
