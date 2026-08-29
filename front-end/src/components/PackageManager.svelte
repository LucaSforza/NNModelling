<script lang="ts">
  import "../styles/package-manager.css";
  import { readBrowserPackageDirectory, type InstallResult, type LocalPackageFile, type PackageIdentity } from "../type-system/packages/install/installer";
  import type { InstalledPackageRecord, PackageKey } from "../type-system/packages/types";

  export type PackageManagerPackage = Pick<InstalledPackageRecord, "key" | "source" | "manifest" | "definition">;

  interface Props {
    packages: readonly PackageManagerPackage[];
    onInstall: (files: readonly LocalPackageFile[]) => Promise<InstallResult> | InstallResult;
    onRemove: (key: PackageKey) => Promise<void> | void;
    onActivationRequest?: (request: PackageIdentity & { readonly key: PackageKey }) => void;
  }

  let { packages, onInstall, onRemove, onActivationRequest }: Props = $props();
  let picker: HTMLInputElement;
  let busy = $state(false);
  let removing = $state<PackageKey | null>(null);
  let result = $state<InstallResult | null>(null);
  let error = $state<string | null>(null);

  let bundled = $derived(packages.filter((item) => item.source === "bundled"));
  let external = $derived(packages.filter((item) => item.source === "external"));

  function openPicker() {
    error = null;
    picker?.click();
  }

  async function handleSelection(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    busy = true;
    error = null;
    result = null;
    try {
      const files = await readBrowserPackageDirectory(input.files);
      result = await onInstall(files);
      if (result.status !== "rejected") onActivationRequest?.(result.activationRequest);
      if (result.status === "rejected") error = result.diagnostic.message;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
      input.value = "";
    }
  }

  async function remove(key: PackageKey) {
    removing = key;
    error = null;
    try {
      await onRemove(key);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      removing = null;
    }
  }
</script>

<section class="package-manager" aria-label="Package manager">
  <header class="package-manager__header">
    <div>
      <h2>Packages</h2>
      <p>Bundled packages are read-only. Install an external package from a directory.</p>
    </div>
    <button type="button" class="package-manager__install" onclick={openPicker} disabled={busy}>
      {busy ? "Installing…" : "Install directory"}
    </button>
    <input
      class="package-manager__picker"
      bind:this={picker}
      type="file"
      multiple
      webkitdirectory
      onchange={handleSelection}
      aria-label="Choose package directory"
    />
  </header>

  {#if error}
    <p class="package-manager__message package-manager__message--error" role="alert">{error}</p>
  {:else if result}
    <p class="package-manager__message" role="status">
      {result.status === "installed" ? "Package installed." : result.status === "already-installed" ? "Package already installed." : result.diagnostic.message}
    </p>
  {/if}

  <div class="package-manager__group">
    <h3>Bundled</h3>
    {#if bundled.length === 0}<p class="package-manager__empty">No bundled packages.</p>{/if}
    {#each bundled as packageInfo (packageInfo.key)}
      <div class="package-manager__row">
        <span><strong>{packageInfo.definition.name}</strong><small>{packageInfo.key}</small></span>
        <em>Core</em>
      </div>
    {/each}
  </div>

  <div class="package-manager__group">
    <h3>External</h3>
    {#if external.length === 0}<p class="package-manager__empty">No installed external packages.</p>{/if}
    {#each external as packageInfo (packageInfo.key)}
      <div class="package-manager__row">
        <span><strong>{packageInfo.definition.name}</strong><small>{packageInfo.key}</small></span>
        <button type="button" onclick={() => remove(packageInfo.key)} disabled={removing === packageInfo.key}>
          {removing === packageInfo.key ? "Removing…" : "Remove"}
        </button>
      </div>
    {/each}
  </div>
</section>
