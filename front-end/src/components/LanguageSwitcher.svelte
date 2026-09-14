<script lang="ts">
  import { useI18n } from "../i18n.svelte";

  type Props = {
    placement?: "landing" | "editor";
  };

  let { placement = "landing" }: Props = $props();
  const i18n = useI18n();
  let targetLabel = $derived(i18n.t(i18n.locale === "en" ? "Switch to Italian" : "Switch to English"));
</script>

<button
  type="button"
  class="language-switcher"
  class:language-switcher--editor={placement === "editor"}
  aria-label={targetLabel}
  title={targetLabel}
  onclick={i18n.toggleLocale}
>
  <span aria-hidden="true">{i18n.locale === "en" ? "🇮🇹" : "🇬🇧"}</span>
  <span>{i18n.locale === "en" ? "Italiano" : "English"}</span>
</button>

<style>
  .language-switcher {
    position: fixed;
    top: 18px;
    right: 20px;
    z-index: 1000;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 40px;
    padding: 8px 12px;
    border: 1px solid #d9e1ee;
    border-radius: 10px;
    background: #fff;
    color: #243653;
    box-shadow: 0 3px 12px rgb(39 59 99 / 12%);
    font: 650 0.84rem system-ui, sans-serif;
    cursor: pointer;
  }

  .language-switcher:hover { background: #f5f8ff; }
  .language-switcher:focus-visible { outline: 3px solid #86aaf7; outline-offset: 2px; }

  .language-switcher--editor {
    top: auto;
    bottom: 18px;
  }
</style>
