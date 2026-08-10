<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { IdeSurfaceState, IdeViewportRect } from "@phaseatlas/contracts";

  export let state: IdeSurfaceState = { targets: [], visibleKey: null };
  export let repositoryName = "";
  export let platform = "desktop";
  export let active = true;
  export let starting = false;
  export let errorMessage = "";
  export let onStop: (key: string) => void = () => undefined;
  export let onClose: () => void = () => undefined;
  // The IDE is a native view, not DOM: it cannot live inside this workspace,
  // only be painted over it. This element measures the exact available area.
  export let onViewport: (rect: IdeViewportRect) => void = () => undefined;

  let viewportElement: HTMLDivElement | undefined;

  $: switchShortcutLabel = platform === "darwin" ? "⌥⇧P" : "Alt+Shift+P";
  $: visibleTarget = state.targets.find((target) => target.key === state.visibleKey);
  $: headline = visibleTarget?.title || repositoryName;

  function publishViewport() {
    if (!viewportElement) return;
    const rect = viewportElement.getBoundingClientRect();
    // A hidden workspace measures zero, which the main process reads as "nowhere to
    // put the view" and hides it — exactly what should happen.
    onViewport(active
      ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
      : { x: 0, y: 0, width: 0, height: 0 });
  }

  // Anything that moves the workspace has to re-report: another surface covering
  // it or a different tab being selected.
  // ResizeObserver alone misses these, because the box is still the same size.
  $: {
    void active;
    void state.visibleKey;
    void tick().then(publishViewport);
  }

  onMount(() => {
    if (!viewportElement) return;
    const observer = new ResizeObserver(publishViewport);
    observer.observe(viewportElement);
    window.addEventListener("resize", publishViewport);
    publishViewport();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", publishViewport);
      onViewport({ x: 0, y: 0, width: 0, height: 0 });
    };
  });
</script>

<div
  class:inactive={!active}
  class="ide-layer"
  aria-hidden={!active}
  aria-labelledby="embedded-ide-title"
>
  <section class="ide-shell">
    <header class="ide-header">
      <div class="ide-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="m9 8-4 4 4 4M15 8l4 4-4 4"/></svg>
      </div>
      <div class="ide-title">
        <p>Embedded IDE</p>
        <h2 id="embedded-ide-title">{headline} <span>/ Theia</span></h2>
      </div>

      {#if visibleTarget}
        <button
          class="ide-chip"
          type="button"
          title="Stop this IDE and free its Theia process"
          onclick={() => onStop(visibleTarget.key)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>
          Stop
        </button>
      {/if}

      <button class="close-ide" type="button" aria-label="Close the embedded IDE" title={`Close (${switchShortcutLabel})`} onclick={onClose}>×</button>
    </header>

    <div class="ide-viewport" bind:this={viewportElement}>
      {#if errorMessage}
        <p class="ide-placeholder error">{errorMessage}</p>
      {:else if starting}
        <p class="ide-placeholder">Starting the IDE for {repositoryName}…</p>
      {:else if state.targets.length === 0}
        <p class="ide-placeholder">No IDE workspace is open.</p>
      {/if}
    </div>
  </section>
</div>

<style>
  .ide-layer { position: fixed; z-index: 96; inset: 0 0 0 var(--sidebar-width); background: var(--surface); }
  .ide-layer.inactive { display: none; }
  .ide-shell { display: grid; width: 100%; height: 100%; grid-template-rows: 50px minmax(0,1fr); overflow: hidden; background: var(--surface); color: var(--text); }
  .ide-header { display: flex; min-width: 0; align-items: center; gap: 10px; border-bottom: 1px solid var(--border); padding: 0 10px 0 14px; background: color-mix(in srgb,var(--surface) 97%,var(--brand-50)); -webkit-app-region: drag; }
  .ide-header button { -webkit-app-region: no-drag; }
  .ide-mark { display: grid; width: 30px; height: 30px; flex: 0 0 30px; place-items: center; border: 1px solid var(--brand-200); border-radius: 9px; background: var(--active-surface); color: var(--brand-600); }
  .ide-mark svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.9; }
  .ide-title { min-width: 150px; flex: 1 1 260px; }
  .ide-title p { margin: 0 0 1px; color: var(--active-text); font-size: 9px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
  .ide-title h2 { overflow: hidden; margin: 0; font-size: 14px; letter-spacing: -.01em; text-overflow: ellipsis; white-space: nowrap; }
  .ide-title h2 span { color: var(--text-subtle); font-weight: 560; }
  .ide-chip { display: flex; flex: 0 0 auto; align-items: center; gap: 5px; border: 1px solid var(--border); border-radius: var(--radius-full); padding: 5px 10px; background: var(--surface); color: var(--text-muted); font-size: 11px; font-weight: 750; white-space: nowrap; }
  .ide-chip:hover { border-color: color-mix(in srgb,var(--warning-500) 52%,var(--border)); background: var(--warning-surface); color: var(--warning-text); }
  .ide-chip svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.8; }
  .close-ide { display: grid; width: 32px; height: 32px; flex: 0 0 32px; place-items: center; border: 0; border-radius: var(--radius); background: transparent; color: var(--text-muted); font-size: 22px; }
  .close-ide:hover { background: var(--surface-soft); color: var(--text); }
  /* Deliberately empty: the Theia view is painted over this box by the main
     process, so anything rendered here is only visible before it arrives. */
  .ide-viewport { display: grid; min-height: 0; place-items: center; background: var(--surface-soft); }
  .ide-placeholder { margin: 0; padding: 0 24px; color: var(--text-subtle); font-size: 13px; text-align: center; }
  .ide-placeholder.error { color: var(--warning-600); }
  @media (max-width: 767.98px) {
    .ide-layer { inset: 0; }
  }
</style>
