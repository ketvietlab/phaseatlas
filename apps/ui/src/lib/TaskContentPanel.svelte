<script lang="ts">
  import { afterUpdate } from "svelte";
  import { browser } from "$app/environment";
  import DOMPurify from "dompurify";
  import { marked } from "marked";
  import type { CanonicalTask } from "@phaseatlas/contracts";

  export let task: CanonicalTask | null = null;
  export let initializing = false;
  export let stream = "";
  export let failure = "";
  export let canInitialize = false;
  export let onClose: () => void = () => undefined;
  export let onEdit: (task: CanonicalTask) => void = () => undefined;
  export let onInitialize: (task: CanonicalTask) => void = () => undefined;

  let markdownRoot: HTMLElement;
  let mermaidRenderKey = "";
  let mermaidError = "";
  let mermaidGeneration = 0;

  marked.use({
    gfm: true,
    breaks: false,
  });

  function renderMarkdown(body: string): string {
    if (!browser) return "";
    const rendered = marked.parse(body, { async: false });
    return DOMPurify.sanitize(typeof rendered === "string" ? rendered : "", {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["style", "iframe", "object", "embed", "form", "input", "button"],
      FORBID_ATTR: ["style", "href", "xlink:href"],
    });
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") onClose();
  }

  async function renderMermaidDiagrams(renderKey: string) {
    const generation = ++mermaidGeneration;
    const codeBlocks = [...markdownRoot.querySelectorAll<HTMLElement>("pre > code.language-mermaid")];
    if (!codeBlocks.length) {
      mermaidError = "";
      return;
    }

    const diagramNodes = codeBlocks.map((codeBlock, index) => {
      const holder = document.createElement("div");
      holder.className = "mermaid-diagram";
      holder.dataset.diagramIndex = String(index + 1);
      holder.setAttribute("role", "img");
      holder.setAttribute("aria-label", `Mermaid diagram ${index + 1}`);
      holder.textContent = codeBlock.textContent ?? "";
      codeBlock.parentElement?.replaceWith(holder);
      return holder;
    });

    try {
      const { default: mermaid } = await import("mermaid");
      if (generation !== mermaidGeneration || renderKey !== mermaidRenderKey) return;
      const dark = document.documentElement.dataset.theme === "dark";
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: dark ? "dark" : "neutral",
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        flowchart: { curve: "basis", useMaxWidth: true, htmlLabels: false },
      });
      await mermaid.run({ nodes: diagramNodes, suppressErrors: true });
      if (generation !== mermaidGeneration) return;
      const failed = diagramNodes.filter((node) => !node.querySelector("svg"));
      failed.forEach((node) => node.classList.add("mermaid-diagram-error"));
      mermaidError = failed.length
        ? `${failed.length} Mermaid diagram${failed.length === 1 ? "" : "s"} could not be rendered. Source is shown instead.`
        : "";
    } catch (error) {
      diagramNodes.forEach((node) => node.classList.add("mermaid-diagram-error"));
      mermaidError = error instanceof Error ? `Mermaid could not render: ${error.message}` : "Mermaid could not render this content.";
    }
  }

  $: renderedMarkdown = task?.content ? renderMarkdown(task.content.body) : "";

  afterUpdate(() => {
    if (!browser || !task?.content || !markdownRoot) return;
    const nextRenderKey = `${task.revision}:${task.content.body.length}:${document.documentElement.dataset.theme ?? "light"}`;
    if (nextRenderKey === mermaidRenderKey) return;
    mermaidRenderKey = nextRenderKey;
    void renderMermaidDiagrams(nextRenderKey);
  });
</script>

<svelte:window onkeydown={handleKeydown} />

{#if task}
  <div class="panel-layer">
    <button class="panel-backdrop" type="button" aria-label="Close task content" onclick={onClose}></button>
    <div class="content-panel" role="dialog" aria-modal="true" aria-labelledby="task-content-title">
      <header class="panel-header">
        <div class="task-heading">
          <span class="task-glyph" aria-hidden="true">{task.key.taskId.slice(-2)}</span>
          <div>
            <p><span>{task.key.taskId}</span><span>{task.phaseId.replaceAll("-", " ")}</span></p>
            <h2 id="task-content-title">{task.title}</h2>
          </div>
        </div>
        <button class="close-button" type="button" aria-label="Close task content" title="Close (Esc)" onclick={onClose}>×</button>
      </header>

      <div class="task-context">
        <span class="state-pill" data-state={task.state}>{task.state.replaceAll("_", " ")}</span>
        <span>{task.kind}</span>
        <span>{task.priority} priority</span>
        {#if task.dependencies.length}<span>{task.dependencies.length} dep{task.dependencies.length === 1 ? "" : "s"}</span>{/if}
      </div>

      <div class="panel-body">
        {#if task.content}
          <article class="markdown-body" bind:this={markdownRoot}>
            {@html renderedMarkdown}
          </article>
          {#if mermaidError}<div class="mermaid-notice" role="status">{mermaidError}</div>{/if}
        {:else}
          <section class="content-empty">
            <span class="empty-document" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg></span>
            <p class="empty-eyebrow">Task body</p>
            <h3>Content has not been initialized</h3>
            <p>The canonical outline is ready. Generate its repository-aware implementation context only when this task is ready to move forward.</p>
            <button type="button" onclick={() => onInitialize(task)} disabled={!canInitialize || initializing}>
              {initializing ? "Initializing content…" : "Initialize task content"}
            </button>
          </section>
        {/if}

        {#if stream || failure}
          <section class="content-stream" data-status={failure ? "failed" : initializing ? "running" : "complete"}>
            <header><span></span><strong>{failure ? "Content agent failed" : initializing ? "Content agent is working" : "Content agent output"}</strong></header>
            <pre>{failure || stream}</pre>
          </section>
        {/if}
      </div>

      <footer class="panel-footer">
        <div>
          <span>{task.content ? "Rendered Markdown" : "Canonical outline"}</span>
          <code>{task.content?.path ?? task.source.documents[0]?.path}</code>
        </div>
        {#if task.content}
          <button class="edit-button" type="button" onclick={() => onEdit(task)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10z"/><path d="m14 7 3 3M4 20h16"/></svg>
            Edit in Monaco
          </button>
        {/if}
      </footer>
    </div>
  </div>
{/if}

<style>
  .panel-layer { position: fixed; z-index: 95; inset: 0; display: flex; justify-content: flex-end; }
  .panel-backdrop { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; border-radius: 0; background: rgba(25,27,31,.34); backdrop-filter: blur(2px); animation: backdrop-in .18s ease-out; }
  .content-panel { position: relative; display: grid; width: min(1020px,calc(100vw - 170px)); min-width: 0; height: 100%; grid-template-rows: auto auto minmax(0,1fr) auto; border-left: 1px solid var(--border); background: var(--surface); color: var(--text); box-shadow: -24px 0 60px rgba(22,24,28,.17); animation: panel-in .24s cubic-bezier(.2,.76,.2,1); }
  .panel-header { display: flex; min-height: 82px; align-items: center; justify-content: space-between; gap: 18px; border-bottom: 1px solid var(--border); padding: 14px 16px 14px 20px; }
  .task-heading { display: flex; min-width: 0; align-items: center; gap: 13px; }.task-glyph { display: grid; width: 42px; height: 42px; flex: 0 0 42px; place-items: center; border: 1px solid var(--brand-200); border-radius: var(--radius); background: var(--active-surface); color: var(--active-text); font: 800 12px/1 "SFMono-Regular",Consolas,monospace; }.task-heading > div { min-width: 0; }.task-heading p { display: flex; gap: 8px; margin: 0 0 4px; color: var(--text-subtle); font-size: 11px; font-weight: 750; text-transform: capitalize; }.task-heading p span:first-child { color: var(--active-text); font-family: "SFMono-Regular",Consolas,monospace; }.task-heading h2 { overflow: hidden; margin: 0; font-size: 17px; letter-spacing: -.015em; text-overflow: ellipsis; white-space: nowrap; }
  .close-button { display: grid; width: 38px; height: 38px; flex: 0 0 38px; place-items: center; border: 1px solid transparent; border-radius: var(--radius); background: transparent; color: var(--text-muted); font-size: 25px; line-height: 1; }.close-button:hover { border-color: var(--border); background: var(--surface-soft); color: var(--text); }
  .task-context { display: flex; min-height: 45px; flex-wrap: wrap; align-items: center; gap: 7px; border-bottom: 1px solid var(--border-soft); padding: 8px 20px; color: var(--text-subtle); font-size: 11px; text-transform: capitalize; }.task-context > span { border: 1px solid var(--border); border-radius: var(--radius-full); padding: 4px 8px; }.task-context .state-pill { border-color: transparent; background: var(--active-surface); color: var(--active-text); font-weight: 750; }.state-pill[data-state="done"] { background: var(--success-surface); color: var(--success-text); }.state-pill[data-state="blocked"],.state-pill[data-state="deferred"] { background: var(--warning-surface); color: var(--warning-600); }
  .panel-body { min-height: 0; overflow: auto; overscroll-behavior: contain; background: color-mix(in srgb,var(--surface) 98%,var(--canvas)); }
  .markdown-body { max-width: 920px; margin: 0 auto; padding: 36px 28px 68px; color: var(--text); font-size: 16px; line-height: 1.72; }
  .markdown-body :global(h1),.markdown-body :global(h2),.markdown-body :global(h3),.markdown-body :global(h4) { color: var(--text); font-weight: 760; letter-spacing: -.018em; line-height: 1.3; scroll-margin-top: 20px; }.markdown-body :global(h1) { margin: 0 0 24px; border-bottom: 1px solid var(--border); padding-bottom: 15px; font-size: 29px; }.markdown-body :global(h2) { margin: 34px 0 13px; border-bottom: 1px solid var(--border-soft); padding-bottom: 8px; font-size: 22px; }.markdown-body :global(h3) { margin: 26px 0 10px; font-size: 18px; }.markdown-body :global(h4) { margin: 20px 0 8px; font-size: 16px; }.markdown-body :global(p) { margin: 0 0 15px; color: var(--text-muted); }.markdown-body :global(strong) { color: var(--text); font-weight: 750; }.markdown-body :global(ul),.markdown-body :global(ol) { margin: 0 0 18px; padding-left: 25px; color: var(--text-muted); }.markdown-body :global(li) { margin: 5px 0; padding-left: 3px; }.markdown-body :global(li::marker) { color: var(--brand-500); font-weight: 750; }.markdown-body :global(blockquote) { margin: 20px 0; border-left: 3px solid var(--brand-400); padding: 10px 16px; background: var(--active-surface); color: var(--text-muted); }.markdown-body :global(blockquote p:last-child) { margin-bottom: 0; }.markdown-body :global(code) { border: 1px solid var(--border); border-radius: var(--radius-xs); padding: 2px 5px; background: var(--surface-soft); color: var(--text); font: 14px/1.5 "SFMono-Regular",Consolas,monospace; }.markdown-body :global(pre) { max-width: 100%; overflow: auto; margin: 18px 0; border: 1px solid #303832; border-radius: var(--radius); padding: 15px 17px; background: #151c18; color: #cbd7cf; }.markdown-body :global(pre code) { border: 0; padding: 0; background: transparent; color: inherit; font-size: 14px; }.markdown-body :global(a) { color: var(--active-text); text-decoration: underline; text-underline-offset: 3px; cursor: default; }.markdown-body :global(hr) { margin: 28px 0; border: 0; border-top: 1px solid var(--border); }.markdown-body :global(table) { width: 100%; margin: 20px 0; border-collapse: collapse; font-size: 14px; }.markdown-body :global(th),.markdown-body :global(td) { border: 1px solid var(--border); padding: 8px 10px; text-align: left; }.markdown-body :global(th) { background: var(--surface-soft); color: var(--text); }
  .markdown-body :global(.mermaid-diagram) { display: grid; max-width: 100%; min-height: 120px; place-items: center; overflow: auto; margin: 24px 0; border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 22px; background: var(--surface-soft); }.markdown-body :global(.mermaid-diagram svg) { width: auto !important; max-width: 100% !important; height: auto; }.markdown-body :global(.mermaid-diagram-error) { place-items: start; background: #151c18; color: #cbd7cf; font: 14px/1.6 "SFMono-Regular",Consolas,monospace; white-space: pre-wrap; }.mermaid-notice { margin: -44px auto 26px; max-width: 824px; border: 1px solid color-mix(in srgb,var(--warning-500) 55%,var(--border)); border-radius: var(--radius); padding: 10px 12px; background: var(--warning-surface); color: var(--warning-600); font-size: 13px; }
  .content-empty { display: grid; min-height: 100%; place-items: center; align-content: center; padding: 48px; text-align: center; }.empty-document { display: grid; width: 64px; height: 64px; place-items: center; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface-soft); color: var(--brand-500); }.empty-document svg { width: 29px; height: 29px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.7; }.empty-eyebrow { margin: 18px 0 3px; color: var(--active-text); font-size: 11px; font-weight: 800; letter-spacing: .09em; text-transform: uppercase; }.content-empty h3 { margin: 0; font-size: 19px; }.content-empty > p:not(.empty-eyebrow) { max-width: 460px; margin: 9px 0 19px; color: var(--text-muted); font-size: 13px; line-height: 1.6; }.content-empty button { min-height: 40px; border: 1px solid var(--brand-600); border-radius: var(--radius); padding: 0 14px; background: var(--brand-600); color: white; font-size: 12px; font-weight: 750; }.content-empty button:disabled { opacity: .5; }
  .content-stream { overflow: hidden; margin: 0 24px 28px; border: 1px solid #34423b; border-radius: var(--radius); background: #111815; color: #c6d1ca; }.content-stream > header { display: flex; align-items: center; gap: 8px; border-bottom: 1px solid #2b3832; padding: 9px 11px; background: #161f1b; }.content-stream > header span { width: 8px; height: 8px; border-radius: 50%; background: #e0aa62; }.content-stream[data-status="running"] > header span { animation: pulse 1.2s ease infinite; }.content-stream[data-status="failed"] > header span { background: #d36b64; }.content-stream strong { font-size: 11px; }.content-stream pre { max-height: 220px; overflow: auto; margin: 0; padding: 12px; color: #9eaaa2; font: 11px/1.6 "SFMono-Regular",Consolas,monospace; white-space: pre-wrap; word-break: break-word; }
  .panel-footer { display: flex; min-height: 66px; align-items: center; justify-content: space-between; gap: 18px; border-top: 1px solid var(--border); padding: 10px 16px 10px 20px; background: color-mix(in srgb,var(--surface) 96%,transparent); backdrop-filter: blur(12px); }.panel-footer > div { min-width: 0; }.panel-footer span,.panel-footer code { display: block; }.panel-footer > div > span { color: var(--text-subtle); font-size: 10px; font-weight: 750; letter-spacing: .06em; text-transform: uppercase; }.panel-footer code { overflow: hidden; margin-top: 3px; border: 0; padding: 0; background: transparent; color: var(--text-muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }.edit-button { display: flex; min-height: 39px; flex: 0 0 auto; align-items: center; gap: 8px; border: 1px solid var(--brand-600); border-radius: var(--radius); padding: 0 13px; background: var(--brand-600); color: white; font-size: 12px; font-weight: 750; }.edit-button:hover { background: var(--brand-700); }.edit-button svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.8; }
  @keyframes panel-in { from { opacity: .7; transform: translateX(28px); } } @keyframes backdrop-in { from { opacity: 0; } }
  @keyframes pulse { 50% { opacity: .35; transform: scale(.72); } }
  @media (max-width: 1100px) { .content-panel { width: min(900px,calc(100vw - 80px)); }.markdown-body { padding-inline: 24px; } }
  @media (max-width: 900px) { .content-panel { width: min(780px,calc(100vw - 40px)); }.markdown-body { padding-inline: 20px; } }
  @media (max-width: 620px) { .content-panel { width: 100vw; }.panel-header { padding-left: 14px; }.task-glyph { display: none; }.task-heading h2 { font-size: 15px; }.task-context { padding-inline: 14px; }.markdown-body { padding: 24px 14px 54px; }.panel-footer { align-items: stretch; flex-direction: column; }.edit-button { justify-content: center; }.content-empty { padding: 28px; } }
  @media (prefers-reduced-motion: reduce) { .content-panel,.panel-backdrop { animation: none; } }
</style>
