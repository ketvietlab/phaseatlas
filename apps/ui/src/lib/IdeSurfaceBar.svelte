<script lang="ts">
  import { onMount } from "svelte";
  import type { IdeSurfaceState } from "@phaseatlas/contracts";

  export let state: IdeSurfaceState = { targets: [], visibleKey: null };
  export let platform = "desktop";
  // Leaving the IDE is never disabled: a surface that covers the window must
  // always have a live way out, whatever else is in flight.
  export let busy = false;
  export let onShow: (key: string) => void = () => undefined;
  export let onHide: () => void = () => undefined;
  export let onClose: (key: string) => void = () => undefined;
  // The main process lays the IDE view out below this strip, so it has to know
  // how tall the strip actually rendered — not how tall we guessed it would be.
  export let onMeasure: (height: number) => void = () => undefined;

  let rootElement: HTMLElement | undefined;

  $: switchShortcutLabel = platform === "darwin" ? "⌥⇧P" : "Alt+Shift+P";

  onMount(() => {
    if (!rootElement) return;
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height;
      if (height) onMeasure(height);
    });
    observer.observe(rootElement);
    onMeasure(rootElement.getBoundingClientRect().height);
    return () => observer.disconnect();
  });
</script>

<div
  class:mac={platform === "darwin"}
  class="ide-surface-bar"
  bind:this={rootElement}
  role="tablist"
  aria-label="Workspace surfaces"
>
  <button
    class:active={state.visibleKey === null}
    class="ide-surface-tab"
    type="button"
    role="tab"
    aria-selected={state.visibleKey === null}
    title={`Back to PhaseAtlas (${switchShortcutLabel})`}
    onclick={onHide}
  >
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h7v12H4zM14 6h6v5h-6zM14 14h6v4h-6z"/></svg>
    <span>PhaseAtlas</span>
    {#if state.visibleKey !== null}<kbd>{switchShortcutLabel}</kbd>{/if}
  </button>

  <span class="ide-surface-divider" aria-hidden="true"></span>

  {#each state.targets as target (target.key)}
    <div class:active={state.visibleKey === target.key} class="ide-surface-slot">
      <button
        class="ide-surface-tab"
        type="button"
        role="tab"
        aria-selected={state.visibleKey === target.key}
        title={`Switch to ${target.title} in the IDE`}
        onclick={() => onShow(target.key)}
        disabled={busy}
      >
        <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="m8 13 2 2-2 2M13 17h4"/></svg>
        <span>{target.title}</span>
        {#if target.leaseId}<em>worktree</em>{/if}
      </button>
      <button
        class="ide-surface-stop"
        type="button"
        aria-label={`Stop the IDE for ${target.title}`}
        title="Stop this IDE and free its resources"
        onclick={() => onClose(target.key)}
        disabled={busy}
      >
        <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>
      </button>
    </div>
  {/each}
</div>

<style>
  .ide-surface-bar {
    position: fixed;
    z-index: 80;
    top: 0;
    right: 0;
    left: 0;
    display: flex;
    min-height: 44px;
    align-items: center;
    gap: 6px;
    border-bottom: 1px solid var(--border);
    padding: 5px 10px;
    background: var(--canvas);
    -webkit-app-region: drag;
  }
  /* Traffic lights float over the top-left of the content area. */
  .ide-surface-bar.mac { padding-left: 82px; }
  .ide-surface-divider { width: 1px; height: 20px; background: var(--border); }
  .ide-surface-slot {
    display: flex;
    min-width: 0;
    align-items: center;
    border: 1px solid transparent;
    border-radius: var(--radius);
  }
  .ide-surface-slot.active { border-color: var(--brand-300); background: var(--active-surface); }
  .ide-surface-slot.active .ide-surface-tab { color: var(--active-text); }
  .ide-surface-tab {
    display: flex;
    min-width: 0;
    min-height: 32px;
    align-items: center;
    gap: 7px;
    border: 1px solid transparent;
    border-radius: var(--radius);
    padding: 4px 10px;
    background: transparent;
    color: var(--text-muted);
    font-size: 12px;
    font-weight: 650;
    -webkit-app-region: no-drag;
  }
  .ide-surface-tab:hover { color: var(--text); }
  .ide-surface-tab.active { border-color: var(--brand-300); background: var(--active-surface); color: var(--active-text); }
  .ide-surface-tab span { overflow: hidden; max-width: 24ch; text-overflow: ellipsis; white-space: nowrap; }
  .ide-surface-tab .icon { width: 15px; height: 15px; flex: 0 0 15px; }
  .ide-surface-tab em {
    flex: 0 0 auto;
    border-radius: var(--radius-xs);
    padding: 1px 5px;
    background: var(--surface-soft);
    color: var(--text-subtle);
    font-size: 9px;
    font-style: normal;
    font-weight: 700;
    letter-spacing: .05em;
    text-transform: uppercase;
  }
  .ide-surface-tab kbd {
    border: 1px solid var(--border);
    border-bottom-width: 2px;
    border-radius: var(--radius-xs);
    padding: 1px 4px;
    background: var(--surface-soft);
    color: var(--text-subtle);
    font: 9px/1.25 "SFMono-Regular", Consolas, monospace;
  }
  .ide-surface-stop {
    display: grid;
    width: 26px;
    height: 26px;
    flex: 0 0 26px;
    place-items: center;
    margin-right: 4px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-subtle);
    -webkit-app-region: no-drag;
  }
  .ide-surface-stop:hover { background: var(--surface); color: var(--warning-600); }
  .ide-surface-stop .icon { width: 12px; height: 12px; }
</style>
