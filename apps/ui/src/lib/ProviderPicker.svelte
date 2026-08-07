<script lang="ts">
  import { tick } from "svelte";
  import type { RunnerDescriptor, RunnerModelDescriptor } from "@phaseatlas/contracts";

  export let runners: RunnerDescriptor[] = [];
  export let runnerId = "";
  export let modelId = "";
  export let reasoningEffort = "";
  export let disabled = false;
  export let placement: "up" | "down" = "up";
  export let onSelect: (
    nextRunnerId: string,
    nextModelId: string,
    nextReasoningEffort: string,
  ) => void = () => undefined;

  type Choice = { runner: RunnerDescriptor; model: RunnerModelDescriptor };

  let open = false;
  let query = "";
  let highlighted = 0;
  let rootElement: HTMLDivElement | undefined;
  let triggerElement: HTMLButtonElement | undefined;
  let popoverElement: HTMLDivElement | undefined;
  let searchElement: HTMLInputElement | undefined;
  let popoverStyle = "visibility: hidden;";

  const POPOVER_GAP = 6;
  const VIEWPORT_MARGIN = 8;

  // .composer-card and .chat-shell both clip with overflow: hidden, so an
  // absolutely positioned popover is cut off inside the composer. Render it on
  // body and position it against the trigger in viewport coordinates instead.
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }

  function positionPopover() {
    if (!open || !triggerElement || !popoverElement) return;
    const trigger = triggerElement.getBoundingClientRect();
    const popover = popoverElement.getBoundingClientRect();
    const maxLeft = window.innerWidth - popover.width - VIEWPORT_MARGIN;
    const left = Math.max(VIEWPORT_MARGIN, Math.min(trigger.left, maxLeft));
    const above = trigger.top - popover.height - POPOVER_GAP;
    const below = trigger.bottom + POPOVER_GAP;
    const fitsAbove = above >= VIEWPORT_MARGIN;
    const fitsBelow = below + popover.height <= window.innerHeight - VIEWPORT_MARGIN;
    const top = placement === "up"
      ? fitsAbove ? above : below
      : fitsBelow ? below : Math.max(VIEWPORT_MARGIN, above);
    popoverStyle = `left: ${Math.round(left)}px; top: ${Math.round(top)}px;`;
  }

  $: activeRunner = runners.find((runner) => runner.id === runnerId);
  $: activeModel = activeRunner?.models.find((model) => model.id === modelId);
  $: activeEfforts = activeModel?.reasoningEfforts ?? [];

  // "Claude Code" reads as Claude, "Codex CLI" as Codex — the vendor word is the
  // part that distinguishes providers, the suffix is noise in a compact button.
  $: runnerLabel = activeRunner?.name.split(" ")[0] ?? runnerId ?? "No CLI";
  $: modelLabel = activeModel?.displayName ?? modelId ?? "No model";
  $: effortLabel = reasoningEffort
    ? `${reasoningEffort.charAt(0).toUpperCase()}${reasoningEffort.slice(1)}`
    : activeEfforts.length ? "Default" : "—";

  $: choices = runners.flatMap((runner) => runner.models.map((model) => ({ runner, model })));
  $: normalizedQuery = query.trim().toLowerCase();
  $: matches = normalizedQuery
    ? choices.filter(({ runner, model }) =>
        `${runner.name} ${model.displayName} ${model.id}`.toLowerCase().includes(normalizedQuery))
    : choices;
  // A runner with no models still belongs in the list: dropping it silently
  // leaves the user unable to tell "not installed" from "installed but signed
  // out". Keep it, and show why it cannot be chosen.
  $: groups = runners
    .map((runner) => ({ runner, models: matches.filter((choice) => choice.runner.id === runner.id) }))
    .filter((group) => group.models.length > 0 || (!normalizedQuery && !group.runner.available));
  $: flattened = groups.flatMap((group) => group.models);
  $: highlighted = Math.min(highlighted, Math.max(flattened.length - 1, 0));

  function defaultEffort(model: RunnerModelDescriptor): string {
    return model.defaultReasoningEffort && model.reasoningEfforts.includes(model.defaultReasoningEffort)
      ? model.defaultReasoningEffort
      : "";
  }

  async function toggle() {
    if (disabled) return;
    open = !open;
    if (!open) return;
    query = "";
    popoverStyle = "visibility: hidden;";
    highlighted = Math.max(flattened.findIndex((choice) => choice.model.id === modelId), 0);
    await tick();
    positionPopover();
    searchElement?.focus();
  }

  function close(restoreFocus = true) {
    if (!open) return;
    open = false;
    if (restoreFocus) triggerElement?.focus();
  }

  function chooseModel(choice: Choice) {
    if (!choice.runner.available) return;
    onSelect(choice.runner.id, choice.model.id, defaultEffort(choice.model));
    close();
  }

  function chooseEffort(effort: string) {
    if (!activeRunner || !activeModel) return;
    onSelect(activeRunner.id, activeModel.id, effort);
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      return;
    }
    if (!flattened.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      highlighted = (highlighted + step + flattened.length) % flattened.length;
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const choice = flattened[highlighted];
      if (choice) chooseModel(choice);
    }
  }

  function handleWindowPointerDown(event: PointerEvent) {
    if (!open) return;
    const target = event.target as Node;
    if (rootElement?.contains(target) || popoverElement?.contains(target)) return;
    close(false);
  }
</script>

<svelte:window
  on:pointerdown={handleWindowPointerDown}
  on:resize={positionPopover}
  on:scroll|capture={positionPopover}
/>

<div class="provider-picker" class:open bind:this={rootElement}>
  <button
    class="provider-trigger"
    type="button"
    bind:this={triggerElement}
    {disabled}
    aria-haspopup="dialog"
    aria-expanded={open}
    title={`${activeRunner?.name ?? "No CLI"} · ${modelLabel} · ${effortLabel} reasoning effort`}
    onclick={toggle}
  >
    <span class="provider-trigger-label">
      <strong>{runnerLabel}</strong><i aria-hidden="true">/</i><strong>{modelLabel}</strong><i aria-hidden="true">/</i><em>{effortLabel}</em>
    </span>
    <span class="provider-trigger-caret" aria-hidden="true"></span>
  </button>

  {#if open}
    <div
      class="provider-popover"
      use:portal
      bind:this={popoverElement}
      style={popoverStyle}
      role="dialog"
      tabindex="-1"
      aria-label="Select agent model"
      onkeydown={handleKeydown}
    >
      <div class="provider-search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></svg>
        <input
          bind:this={searchElement}
          bind:value={query}
          type="search"
          autocomplete="off"
          spellcheck="false"
          placeholder="Search model or CLI"
          aria-label="Search model or CLI"
        />
      </div>

      <div class="provider-options" role="listbox" aria-label="Discovered models">
        {#each groups as group}
          <p class="provider-group">{group.runner.name}{#if !group.runner.available}<span>unavailable</span>{/if}</p>
          {#if !group.models.length}
            <p class="provider-unavailable">{group.runner.unavailableReason ?? `${group.runner.name} is unavailable.`}</p>
          {/if}
          {#each group.models as choice}
            {@const index = flattened.indexOf(choice)}
            {@const selected = choice.runner.id === runnerId && choice.model.id === modelId}
            <button
              class="provider-option"
              class:highlighted={index === highlighted}
              class:selected
              type="button"
              role="option"
              aria-selected={selected}
              disabled={!group.runner.available}
              onmousemove={() => highlighted = index}
              onclick={() => chooseModel(choice)}
            >
              <span class="provider-option-name">{choice.model.displayName}</span>
              {#if choice.model.isDefault}<span class="provider-option-tag">default</span>{/if}
              {#if selected}<span class="provider-option-check" aria-hidden="true"></span>{/if}
            </button>
          {/each}
        {:else}
          <p class="provider-empty">No model matches “{query}”.</p>
        {/each}
      </div>

      <div class="provider-effort">
        <span>Effort</span>
        {#if activeEfforts.length}
          <div class="provider-effort-options">
            <button class:active={!reasoningEffort} type="button" onclick={() => chooseEffort("")}>Default</button>
            {#each activeEfforts as effort}
              <button class:active={reasoningEffort === effort} type="button" onclick={() => chooseEffort(effort)}>{effort}</button>
            {/each}
          </div>
        {:else}
          <small>{modelLabel} does not expose reasoning effort</small>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .provider-picker { position: relative; min-width: 0; }
  .provider-trigger { display: flex; max-width: 260px; min-width: 0; height: 24px; align-items: center; gap: 6px; border: 1px solid var(--border); border-radius: var(--radius-xs); padding: 0 6px; background: var(--surface-soft); color: var(--text-muted); }
  .provider-trigger:hover:not(:disabled) { border-color: var(--brand-300); background: var(--active-surface); color: var(--active-text); }
  .provider-trigger:disabled { cursor: not-allowed; opacity: .5; }
  .provider-picker.open .provider-trigger { border-color: var(--brand-400,var(--brand-300)); background: var(--active-surface); color: var(--active-text); }
  .provider-trigger-label { display: flex; min-width: 0; align-items: baseline; gap: 4px; overflow: hidden; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
  .provider-trigger-label strong { overflow: hidden; font-weight: 750; text-overflow: ellipsis; }
  .provider-trigger-label i { flex: 0 0 auto; color: var(--text-subtle); font-style: normal; }
  .provider-trigger-label em { flex: 0 0 auto; color: var(--text-subtle); font-style: normal; font-weight: 650; }
  .provider-trigger-caret { flex: 0 0 auto; width: 5px; height: 5px; border-right: 1.2px solid currentColor; border-bottom: 1.2px solid currentColor; transform: translateY(-1px) rotate(45deg); }
  .provider-picker.open .provider-trigger-caret { transform: translateY(1px) rotate(225deg); }

  .provider-popover { position: fixed; z-index: 150; display: flex; width: 268px; max-width: calc(100vw - 16px); flex-direction: column; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); box-shadow: var(--shadow-hover); }

  .provider-search { display: flex; align-items: center; gap: 6px; border-bottom: 1px solid var(--border-soft); padding: 7px 9px; }
  .provider-search svg { width: 13px; height: 13px; flex: 0 0 13px; fill: none; stroke: var(--text-subtle); stroke-linecap: round; stroke-width: 1.8; }
  .provider-search input { width: 100%; min-width: 0; border: 0; background: transparent; color: var(--text); font-family: inherit; font-size: 11px; outline: none; }

  .provider-options { max-height: 216px; overflow-y: auto; padding: 4px; }
  .provider-group { display: flex; align-items: center; gap: 6px; margin: 4px 0 2px; padding: 0 6px; color: var(--text-subtle); font-size: 9px; font-weight: 750; letter-spacing: .06em; text-transform: uppercase; }
  .provider-group span { border-radius: var(--radius-full); padding: 1px 5px; background: var(--surface-soft); font-size: 8px; letter-spacing: 0; text-transform: none; }
  .provider-option { display: flex; width: 100%; align-items: center; gap: 6px; border: 0; border-radius: var(--radius-xs); padding: 5px 6px; background: transparent; color: var(--text); font-size: 11px; text-align: left; }
  .provider-option.highlighted:not(:disabled) { background: var(--active-surface); color: var(--active-text); }
  .provider-option.selected { font-weight: 750; }
  .provider-option:disabled { cursor: not-allowed; opacity: .45; }
  .provider-option-name { overflow: hidden; flex: 1; text-overflow: ellipsis; white-space: nowrap; }
  .provider-option-tag { flex: 0 0 auto; border-radius: var(--radius-full); padding: 1px 5px; background: var(--surface-soft); color: var(--text-subtle); font-size: 8px; }
  .provider-option-check { width: 5px; height: 9px; flex: 0 0 auto; border-right: 1.6px solid currentColor; border-bottom: 1.6px solid currentColor; transform: translateY(-1px) rotate(45deg); }
  .provider-empty { margin: 10px 8px; color: var(--text-subtle); font-size: 11px; }
  .provider-unavailable { margin: 0 6px 4px; color: var(--text-subtle); font-size: 10px; line-height: 1.45; }

  .provider-effort { display: flex; align-items: center; gap: 8px; border-top: 1px solid var(--border-soft); padding: 6px 8px; }
  .provider-effort > span { color: var(--text-subtle); font-size: 9px; font-weight: 750; letter-spacing: .06em; text-transform: uppercase; }
  .provider-effort small { color: var(--text-subtle); font-size: 10px; }
  .provider-effort-options { display: flex; flex-wrap: wrap; gap: 3px; }
  .provider-effort-options button { border: 1px solid var(--border); border-radius: var(--radius-full); padding: 2px 7px; background: var(--surface-soft); color: var(--text-muted); font-size: 9px; font-weight: 700; }
  .provider-effort-options button.active { border-color: var(--brand-300); background: var(--active-surface); color: var(--active-text); }
</style>
