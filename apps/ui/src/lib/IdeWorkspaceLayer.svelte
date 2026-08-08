<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { IdeSurfaceState, IdeViewportRect } from "@phaseatlas/contracts";

  export let state: IdeSurfaceState = { targets: [], visibleKey: null };
  export let repositoryName = "";
  export let platform = "desktop";
  export let active = true;
  export let terminalOpen = false;
  export let terminalHeight = 0;
  export let starting = false;
  export let errorMessage = "";
  export let onShow: (key: string) => void = () => undefined;
  export let onStop: (key: string) => void = () => undefined;
  export let onClose: () => void = () => undefined;
  // The IDE is a native view, not DOM: it cannot live inside this card, only be
  // painted over it. So the card measures the hole it leaves and reports it.
  export let onViewport: (rect: IdeViewportRect) => void = () => undefined;

  let viewportElement: HTMLDivElement | undefined;

  $: switchShortcutLabel = platform === "darwin" ? "⌥⇧P" : "Alt+Shift+P";
  $: visibleTarget = state.targets.find((target) => target.key === state.visibleKey);
  $: headline = visibleTarget?.title || repositoryName;

  function publishViewport() {
    if (!viewportElement) return;
    const rect = viewportElement.getBoundingClientRect();
    // A hidden card measures zero, which the main process reads as "nowhere to
    // put the view" and hides it — exactly what should happen.
    onViewport(active
      ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
      : { x: 0, y: 0, width: 0, height: 0 });
  }

  // Anything that moves the card has to re-report: the terminal opening under
  // it, the card being covered by another surface, a different tab selected.
  // ResizeObserver alone misses these, because the box is still the same size.
  $: {
    void active;
    void terminalOpen;
    void terminalHeight;
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
  style={`--chat-terminal-inset: ${terminalOpen ? terminalHeight : 0}px`}
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

      {#if state.targets.length > 1}
        <div class="ide-tabs" role="tablist" aria-label="Open IDE workspaces">
          {#each state.targets as target (target.key)}
            <button
              class:active={state.visibleKey === target.key}
              class="ide-tab"
              type="button"
              role="tab"
              aria-selected={state.visibleKey === target.key}
              title={`Switch to ${target.title}`}
              onclick={() => onShow(target.key)}
            >
              <span>{target.title}</span>
              {#if target.leaseId}<em>worktree</em>{/if}
            </button>
          {/each}
        </div>
      {/if}

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
  .ide-layer { position: fixed; z-index: 96; inset: 0 0 var(--chat-terminal-inset,0px) var(--sidebar-width); padding: 10px; background: color-mix(in srgb,var(--canvas) 82%,transparent); backdrop-filter: blur(12px); animation: ide-in .2s cubic-bezier(.2,.76,.2,1); }
  .ide-layer.inactive { display: none; }
  .ide-shell { display: grid; width: 100%; height: 100%; grid-template-rows: 64px minmax(0,1fr); overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); color: var(--text); box-shadow: 0 24px 80px rgba(16,22,19,.18); }
  .ide-header { display: grid; min-width: 0; grid-template-columns: 40px minmax(180px,1fr) auto auto 36px; align-items: center; gap: 8px; border-bottom: 1px solid var(--border); padding: 0 12px 0 16px; background: color-mix(in srgb,var(--surface) 96%,var(--brand-50)); -webkit-app-region: drag; }
  .ide-header button { -webkit-app-region: no-drag; }
  .ide-mark { display: grid; width: 32px; height: 32px; place-items: center; border: 1px solid var(--brand-200); border-radius: 10px; background: var(--active-surface); color: var(--brand-600); }
  .ide-mark svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.9; }
  .ide-title { min-width: 0; }
  .ide-title p { margin: 0 0 2px; color: var(--active-text); font-size: 11px; font-weight: 800; letter-spacing: .09em; text-transform: uppercase; }
  .ide-title h2 { overflow: hidden; margin: 0; font-size: 16px; letter-spacing: -.015em; text-overflow: ellipsis; white-space: nowrap; }
  .ide-title h2 span { color: var(--text-subtle); font-weight: 560; }
  .ide-tabs { display: flex; min-width: 0; align-items: center; gap: 4px; overflow-x: auto; }
  .ide-tab { display: flex; min-width: 0; align-items: center; gap: 6px; border: 1px solid var(--border); border-radius: var(--radius-full); padding: 5px 10px; background: var(--surface); color: var(--text-muted); font-size: 11px; font-weight: 700; }
  .ide-tab:hover { border-color: var(--brand-300); color: var(--text); }
  .ide-tab.active { border-color: var(--brand-300); background: var(--active-surface); color: var(--active-text); }
  .ide-tab span { overflow: hidden; max-width: 22ch; text-overflow: ellipsis; white-space: nowrap; }
  .ide-tab em { border-radius: var(--radius-xs); padding: 1px 5px; background: var(--surface-soft); color: var(--text-subtle); font-size: 9px; font-style: normal; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
  .ide-chip { display: flex; align-items: center; gap: 5px; border: 1px solid var(--border); border-radius: var(--radius-full); padding: 5px 10px; background: var(--surface); color: var(--text-muted); font-size: 11px; font-weight: 750; white-space: nowrap; }
  .ide-chip:hover { border-color: color-mix(in srgb,var(--warning-500) 52%,var(--border)); background: var(--warning-surface); color: var(--warning-text); }
  .ide-chip svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.8; }
  .close-ide { display: grid; width: 34px; height: 34px; place-items: center; border: 0; border-radius: var(--radius); background: transparent; color: var(--text-muted); font-size: 24px; }
  .close-ide:hover { background: var(--surface-soft); color: var(--text); }
  /* Deliberately empty: the Theia view is painted over this box by the main
     process, so anything rendered here is only visible before it arrives. */
  .ide-viewport { display: grid; min-height: 0; place-items: center; background: var(--surface-soft); }
  .ide-placeholder { margin: 0; padding: 0 24px; color: var(--text-subtle); font-size: 13px; text-align: center; }
  .ide-placeholder.error { color: var(--warning-600); }
  @keyframes ide-in { from { opacity: .4; transform: translateY(7px) scale(.997); } }
  @media (max-width: 767.98px) {
    .ide-layer { inset: 0 0 var(--chat-terminal-inset,0px); padding: 0; }
    .ide-shell { border: 0; border-radius: 0; }
    .ide-header { grid-template-columns: 40px minmax(0,1fr) auto 36px; }
    .ide-tabs { display: none; }
  }
</style>
