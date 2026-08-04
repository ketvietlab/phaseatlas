<script lang="ts">
  export let theme: "light" | "dark" = "light";
  export let panelOpen = false;
  export let panelHeight = 300;
  export let panelMaximized = false;
</script>

<section
  class:panel-open={panelOpen}
  class:panel-maximized={panelMaximized}
  class="workbench-shell"
  data-theme={theme}
  style={`--workbench-panel-height: ${panelHeight}px`}
  aria-label="Repository workbench"
>
  <div class="workbench-titlebar"><slot name="titlebar"></slot></div>
  <div class="workbench-sidebar"><slot name="sidebar"></slot></div>
  <div class="workbench-content"><slot name="content"></slot></div>
  {#if panelOpen}
    <div class="workbench-panel"><slot name="panel"></slot></div>
  {/if}
</section>

<style>
  .workbench-shell {
    position: fixed;
    z-index: 120;
    inset: 0;
    display: grid;
    grid-template-columns: 264px minmax(0, 1fr);
    grid-template-rows: 58px minmax(0, 1fr) 0;
    overflow: hidden;
    background: var(--canvas);
    color: var(--text);
  }

  .workbench-shell.panel-open {
    grid-template-rows: 58px minmax(0, 1fr) minmax(180px, min(var(--workbench-panel-height), calc(100vh - 116px)));
  }

  .workbench-shell.panel-maximized {
    grid-template-rows: 58px 0 minmax(180px, 1fr);
  }

  .workbench-titlebar {
    min-width: 0;
    grid-column: 1 / -1;
    grid-row: 1;
  }

  .workbench-sidebar {
    min-width: 0;
    min-height: 0;
    grid-column: 1;
    grid-row: 2 / 4;
    overflow: hidden;
  }

  .workbench-content {
    min-width: 0;
    min-height: 0;
    grid-column: 2;
    grid-row: 2;
    overflow: hidden;
  }

  .workbench-panel {
    min-width: 0;
    min-height: 0;
    grid-column: 2;
    grid-row: 3;
    overflow: hidden;
  }

  .workbench-titlebar > :global(*),
  .workbench-sidebar > :global(*),
  .workbench-content > :global(*),
  .workbench-panel > :global(*) {
    width: 100%;
    height: 100%;
  }

  @media (max-width: 760px) {
    .workbench-shell { grid-template-columns: 210px minmax(0, 1fr); }
  }

  @media (max-width: 520px) {
    .workbench-shell { grid-template-columns: 168px minmax(0, 1fr); }
  }
</style>
