<script lang="ts">
  import type { Diagram } from "../Diagram.svelte";
  import type { ActivePackageMetadata } from "../type-system/host";
  import { groupedPackages } from "../type-system/editor/package-ui";

  interface Props {
    diagram: Diagram;
    packageCatalog?: readonly ActivePackageMetadata[];
    selectedPackage?: ActivePackageMetadata | null;
    onPackageChange?: (metadata: ActivePackageMetadata | null) => void;
  }

  let {
    diagram,
    packageCatalog = [],
    selectedPackage = null,
    onPackageChange,
  }: Props = $props();

  let packageGroups = $derived(groupedPackages(packageCatalog));

  function handleChange(event: Event) {
    const select = event.target as HTMLSelectElement;
    const value = select.value;
    const found = packageCatalog.find((metadata) => `${metadata.id}@${metadata.version}` === value);
    onPackageChange?.(found ?? null);
  }
</script>

<select
  name="packages"
  id="packages"
  value={selectedPackage ? `${selectedPackage.id}@${selectedPackage.version}` : ""}
  onchange={handleChange}
>
  <option value="">-- aggiungi package --</option>
    {#each packageGroups as group (group.name)}
      <optgroup label={group.name}>
        {#each group.packages as metadata (`${metadata.id}@${metadata.version}`)}
          <option value={`${metadata.id}@${metadata.version}`}>
            {metadata.definition.name}
          </option>
        {/each}
      </optgroup>
    {/each}
</select>

<style>
  @import "../styles/dropdown.css";
</style>
