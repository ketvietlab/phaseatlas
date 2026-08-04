<script lang="ts">
  import { afterUpdate } from "svelte";
  import { browser } from "$app/environment";
  import DOMPurify from "dompurify";
  import { marked } from "marked";
  import type { CanonicalTask, RepositoryFileDocument } from "@phaseatlas/contracts";

  export let checkoutId: string;
  export let task: CanonicalTask | null = null;
  export let initializing = false;
  export let stream = "";
  export let failure = "";
  export let canInitialize = false;
  export let canRun = false;
  export let runCount = 0;
  export let onClose: () => void = () => undefined;
  export let onEdit: (task: CanonicalTask) => void = () => undefined;
  export let onInitialize: (task: CanonicalTask) => void = () => undefined;
  export let onRun: (task: CanonicalTask) => void = () => undefined;

  let markdownRoot: HTMLElement;
  let documentMarkdownRoot: HTMLElement;
  let mermaidRenderKey = "";
  let mermaidError = "";
  let mermaidGeneration = 0;
  let documentMermaidRenderKey = "";
  let documentMermaidError = "";
  let documentMermaidGeneration = 0;
  let repositoryDocument: RepositoryFileDocument | null = null;
  let repositoryDocumentPath = "";
  let repositoryDocumentHref = "";
  let repositoryDocumentSourcePath = "";
  let repositoryDocumentLoading = false;
  let repositoryDocumentError = "";
  let repositoryDocumentRequest = 0;
  let documentTaskIdentity = "";

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
      FORBID_ATTR: ["style", "xlink:href"],
    });
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    if (repositoryDocumentPath) closeRepositoryDocument();
    else onClose();
  }

  function normalizeRepositoryPath(path: string): string {
    const segments: string[] = [];
    for (const segment of path.replaceAll("\\", "/").split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") {
        if (!segments.length) return "";
        segments.pop();
        continue;
      }
      segments.push(segment);
    }
    return segments.join("/");
  }

  function repositoryLinkCandidates(href: string, sourcePath: string): string[] {
    let decodedPath = href.split(/[?#]/, 1)[0] ?? "";
    try {
      decodedPath = decodeURIComponent(decodedPath);
    } catch {
      return [];
    }
    if (!decodedPath || /^[a-z][a-z\d+.-]*:/i.test(decodedPath)) return [];
    if (decodedPath.startsWith("/")) return [normalizeRepositoryPath(decodedPath.slice(1))].filter(Boolean);

    const sourceDirectory = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
    const relativePath = normalizeRepositoryPath(`${sourceDirectory}/${decodedPath}`);
    const rootPath = normalizeRepositoryPath(decodedPath);
    return [...new Set([relativePath, rootPath].filter(Boolean))];
  }

  function scrollToMarkdownAnchor(root: Element, href: string) {
    let anchor = href.slice(1);
    try {
      anchor = decodeURIComponent(anchor);
    } catch {
      return;
    }
    if (!anchor) return;
    root.querySelector<HTMLElement>(`#${CSS.escape(anchor)}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function handleMarkdownLink(event: MouseEvent, sourcePath: string) {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest<HTMLAnchorElement>("a[href]");
    const root = event.currentTarget;
    if (!link || !(root instanceof Element) || !root.contains(link)) return;
    const href = link.getAttribute("href")?.trim() ?? "";
    if (!href) return;
    event.preventDefault();

    if (href.startsWith("#")) {
      scrollToMarkdownAnchor(root, href);
      return;
    }
    if (/^https:\/\//i.test(href)) {
      window.open(href, "_blank", "noopener,noreferrer");
      return;
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(href)) return;
    void openRepositoryDocument(href, sourcePath);
  }

  function repositoryLinks(node: HTMLElement, initialSourcePath: string) {
    let sourcePath = initialSourcePath;
    const handleClick = (event: MouseEvent) => handleMarkdownLink(event, sourcePath);
    node.addEventListener("click", handleClick);
    return {
      update(nextSourcePath: string) {
        sourcePath = nextSourcePath;
      },
      destroy() {
        node.removeEventListener("click", handleClick);
      },
    };
  }

  async function openRepositoryDocument(href: string, sourcePath: string) {
    if (!window.phaseatlas || !checkoutId) return;
    const candidates = repositoryLinkCandidates(href, sourcePath);
    if (!candidates.length) return;
    const requestId = ++repositoryDocumentRequest;
    repositoryDocument = null;
    repositoryDocumentHref = href;
    repositoryDocumentSourcePath = sourcePath;
    repositoryDocumentPath = candidates[0];
    repositoryDocumentLoading = true;
    repositoryDocumentError = "";
    let lastError: unknown;
    for (const path of candidates) {
      try {
        const document = await window.phaseatlas.files.read(checkoutId, path);
        if (requestId !== repositoryDocumentRequest) return;
        repositoryDocument = document;
        repositoryDocumentPath = document.path;
        repositoryDocumentLoading = false;
        return;
      } catch (error) {
        lastError = error;
      }
    }
    if (requestId !== repositoryDocumentRequest) return;
    repositoryDocumentLoading = false;
    repositoryDocumentError = lastError instanceof Error ? lastError.message : "The repository document could not be opened.";
  }

  function retryRepositoryDocument() {
    if (repositoryDocumentHref && repositoryDocumentSourcePath) {
      void openRepositoryDocument(repositoryDocumentHref, repositoryDocumentSourcePath);
    }
  }

  function closeRepositoryDocument() {
    repositoryDocumentRequest += 1;
    documentMermaidGeneration += 1;
    repositoryDocument = null;
    repositoryDocumentPath = "";
    repositoryDocumentHref = "";
    repositoryDocumentSourcePath = "";
    repositoryDocumentLoading = false;
    repositoryDocumentError = "";
    documentMermaidRenderKey = "";
    documentMermaidError = "";
  }

  export function closeActiveSurface() {
    if (repositoryDocumentPath) closeRepositoryDocument();
    else onClose();
  }

  function isMarkdownDocument(path: string) {
    return /\.(md|mdx|markdown)$/i.test(path);
  }

  type MermaidScope = "task" | "document";

  function beginMermaidRender(scope: MermaidScope): number {
    if (scope === "task") return ++mermaidGeneration;
    return ++documentMermaidGeneration;
  }

  function mermaidRenderIsCurrent(scope: MermaidScope, generation: number, renderKey: string): boolean {
    return scope === "task"
      ? generation === mermaidGeneration && renderKey === mermaidRenderKey
      : generation === documentMermaidGeneration && renderKey === documentMermaidRenderKey;
  }

  function setMermaidError(scope: MermaidScope, message: string) {
    if (scope === "task") mermaidError = message;
    else documentMermaidError = message;
  }

  async function renderMermaidDiagrams(root: HTMLElement, renderKey: string, scope: MermaidScope) {
    const generation = beginMermaidRender(scope);
    const codeBlocks = [...root.querySelectorAll<HTMLElement>("pre > code.language-mermaid")];
    if (!codeBlocks.length) {
      setMermaidError(scope, "");
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
      if (!mermaidRenderIsCurrent(scope, generation, renderKey)) return;
      const dark = document.documentElement.dataset.theme === "dark";
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: dark ? "dark" : "neutral",
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        flowchart: { curve: "basis", useMaxWidth: true, htmlLabels: false },
      });
      await mermaid.run({ nodes: diagramNodes, suppressErrors: true });
      if (!mermaidRenderIsCurrent(scope, generation, renderKey)) return;
      const failed = diagramNodes.filter((node) => !node.querySelector("svg"));
      failed.forEach((node) => node.classList.add("mermaid-diagram-error"));
      setMermaidError(scope, failed.length
        ? `${failed.length} Mermaid diagram${failed.length === 1 ? "" : "s"} could not be rendered. Source is shown instead.`
        : "");
    } catch (error) {
      diagramNodes.forEach((node) => node.classList.add("mermaid-diagram-error"));
      setMermaidError(scope, error instanceof Error ? `Mermaid could not render: ${error.message}` : "Mermaid could not render this content.");
    }
  }

  $: renderedMarkdown = task?.content ? renderMarkdown(task.content.body) : "";
  $: repositoryDocumentMarkdown = repositoryDocument && isMarkdownDocument(repositoryDocument.path)
    ? renderMarkdown(repositoryDocument.content)
    : "";
  $: currentTaskIdentity = task ? `${task.key.workspaceSlug}:${task.key.taskId}:${task.revision}` : "";
  $: if (currentTaskIdentity !== documentTaskIdentity) {
    documentTaskIdentity = currentTaskIdentity;
    closeRepositoryDocument();
  }

  afterUpdate(() => {
    if (!browser) return;
    const activeTheme = document.documentElement.dataset.theme ?? "light";
    if (task?.content && markdownRoot) {
      const nextRenderKey = `${task.revision}:${task.content.body.length}:${activeTheme}`;
      if (nextRenderKey !== mermaidRenderKey) {
        mermaidRenderKey = nextRenderKey;
        void renderMermaidDiagrams(markdownRoot, nextRenderKey, "task");
      }
    }
    if (repositoryDocument && repositoryDocumentMarkdown && documentMarkdownRoot) {
      const nextDocumentRenderKey = `${repositoryDocument.path}:${repositoryDocument.content.length}:${activeTheme}`;
      if (nextDocumentRenderKey !== documentMermaidRenderKey) {
        documentMermaidRenderKey = nextDocumentRenderKey;
        void renderMermaidDiagrams(documentMarkdownRoot, nextDocumentRenderKey, "document");
      }
    }
  });
</script>

<svelte:window onkeydown={handleKeydown} />

{#if task}
  <div class="panel-layer">
    <button class="panel-backdrop" type="button" aria-label="Close task content" onclick={onClose}></button>
    <div class:document-open={Boolean(repositoryDocumentPath)} class="content-panel" role="dialog" aria-modal="true" aria-labelledby="task-content-title">
      <section class="task-pane">
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
            <article class="markdown-body" bind:this={markdownRoot} use:repositoryLinks={task.content.path}>
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
          <div class="panel-actions">
            {#if task.content}
              <button class="edit-button" type="button" onclick={() => onEdit(task)}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10z"/><path d="m14 7 3 3M4 20h16"/></svg>
                Edit in Monaco
              </button>
            {/if}
            <button class="run-button" type="button" onclick={() => onRun(task)} disabled={!canRun} title={canRun ? "Open this task in the run workbench" : "Choose an available repository provider and model first"}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z"/></svg>
              Run task{runCount ? ` · ${runCount}` : ""}
            </button>
          </div>
        </footer>
      </section>

      {#if repositoryDocumentPath}
        <aside class="repository-document" aria-label={`Repository document ${repositoryDocumentPath}`}>
          <header class="document-header">
            <div class="document-heading">
              <span class="document-glyph" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h5"/></svg></span>
              <div><small>Repository document</small><strong title={repositoryDocumentPath}>{repositoryDocumentPath}</strong></div>
            </div>
            <button class="document-close" type="button" aria-label="Close repository document" title="Close document (Esc)" onclick={closeRepositoryDocument}>×</button>
          </header>
          <div class="document-body">
            {#if repositoryDocumentLoading}
              <div class="document-state" aria-live="polite"><span class="document-spinner"></span><strong>Opening document…</strong><p>{repositoryDocumentPath}</p></div>
            {:else if repositoryDocumentError}
              <div class="document-state document-failure" role="alert">
                <span class="document-alert">!</span><strong>Document could not be opened</strong><p>{repositoryDocumentError}</p><button type="button" onclick={retryRepositoryDocument}>Try again</button>
              </div>
            {:else if repositoryDocument}
              {#if repositoryDocumentMarkdown}
                <article class="markdown-body document-markdown" bind:this={documentMarkdownRoot} use:repositoryLinks={repositoryDocument.path}>{@html repositoryDocumentMarkdown}</article>
                {#if documentMermaidError}<div class="mermaid-notice document-mermaid-notice" role="status">{documentMermaidError}</div>{/if}
              {:else}
                <pre class="document-source"><code>{repositoryDocument.content}</code></pre>
              {/if}
            {/if}
          </div>
        </aside>
      {/if}
    </div>
  </div>
{/if}

<style>
  .panel-layer { position: fixed; z-index: 95; inset: 0; display: flex; justify-content: flex-end; }
  .panel-backdrop { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; border-radius: 0; background: rgba(25,27,31,.34); backdrop-filter: blur(2px); animation: backdrop-in .18s ease-out; }
  .content-panel { --task-pane-width: min(1020px,calc(100vw - 170px)); position: relative; display: grid; width: var(--task-pane-width); min-width: 0; height: 100%; grid-template-columns: minmax(0,1fr); overflow: hidden; border-left: 1px solid var(--border); background: var(--surface); color: var(--text); box-shadow: -24px 0 60px rgba(22,24,28,.17); animation: panel-in .24s cubic-bezier(.2,.76,.2,1); }
  .content-panel.document-open { width: 100vw; grid-template-columns: var(--task-pane-width) minmax(0,1fr); }
  .task-pane { display: grid; min-width: 0; min-height: 0; grid-template-rows: auto auto minmax(0,1fr) auto; overflow: hidden; }
  .panel-header { display: flex; min-height: 82px; align-items: center; justify-content: space-between; gap: 18px; border-bottom: 1px solid var(--border); padding: 14px 16px 14px 20px; }
  .task-heading { display: flex; min-width: 0; align-items: center; gap: 13px; }.task-glyph { display: grid; width: 42px; height: 42px; flex: 0 0 42px; place-items: center; border: 1px solid var(--brand-200); border-radius: var(--radius); background: var(--active-surface); color: var(--active-text); font: 800 12px/1 "SFMono-Regular",Consolas,monospace; }.task-heading > div { min-width: 0; }.task-heading p { display: flex; gap: 8px; margin: 0 0 4px; color: var(--text-subtle); font-size: 11px; font-weight: 750; text-transform: capitalize; }.task-heading p span:first-child { color: var(--active-text); font-family: "SFMono-Regular",Consolas,monospace; }.task-heading h2 { overflow: hidden; margin: 0; font-size: 17px; letter-spacing: -.015em; text-overflow: ellipsis; white-space: nowrap; }
  .close-button { display: grid; width: 38px; height: 38px; flex: 0 0 38px; place-items: center; border: 1px solid transparent; border-radius: var(--radius); background: transparent; color: var(--text-muted); font-size: 25px; line-height: 1; }.close-button:hover { border-color: var(--border); background: var(--surface-soft); color: var(--text); }
  .task-context { display: flex; min-height: 45px; flex-wrap: wrap; align-items: center; gap: 7px; border-bottom: 1px solid var(--border-soft); padding: 8px 20px; color: var(--text-subtle); font-size: 11px; text-transform: capitalize; }.task-context > span { border: 1px solid var(--border); border-radius: var(--radius-full); padding: 4px 8px; }.task-context .state-pill { border-color: transparent; background: var(--active-surface); color: var(--active-text); font-weight: 750; }.state-pill[data-state="done"] { background: var(--success-surface); color: var(--success-text); }.state-pill[data-state="blocked"],.state-pill[data-state="deferred"] { background: var(--warning-surface); color: var(--warning-600); }
  .panel-body { min-height: 0; overflow: auto; overscroll-behavior: contain; background: color-mix(in srgb,var(--surface) 98%,var(--canvas)); }
  .markdown-body { max-width: 920px; margin: 0 auto; padding: 36px 28px 68px; color: var(--text); font-size: 16px; line-height: 1.72; }
  .markdown-body :global(h1),.markdown-body :global(h2),.markdown-body :global(h3),.markdown-body :global(h4) { color: var(--text); font-weight: 760; letter-spacing: -.018em; line-height: 1.3; scroll-margin-top: 20px; }.markdown-body :global(h1) { margin: 0 0 24px; border-bottom: 1px solid var(--border); padding-bottom: 15px; font-size: 29px; }.markdown-body :global(h2) { margin: 34px 0 13px; border-bottom: 1px solid var(--border-soft); padding-bottom: 8px; font-size: 22px; }.markdown-body :global(h3) { margin: 26px 0 10px; font-size: 18px; }.markdown-body :global(h4) { margin: 20px 0 8px; font-size: 16px; }.markdown-body :global(p) { margin: 0 0 15px; color: var(--text-muted); }.markdown-body :global(strong) { color: var(--text); font-weight: 750; }.markdown-body :global(ul),.markdown-body :global(ol) { margin: 0 0 18px; padding-left: 25px; color: var(--text-muted); }.markdown-body :global(li) { margin: 5px 0; padding-left: 3px; }.markdown-body :global(li::marker) { color: var(--brand-500); font-weight: 750; }.markdown-body :global(blockquote) { margin: 20px 0; border-left: 3px solid var(--brand-400); padding: 10px 16px; background: var(--active-surface); color: var(--text-muted); }.markdown-body :global(blockquote p:last-child) { margin-bottom: 0; }.markdown-body :global(code) { border: 1px solid var(--border); border-radius: var(--radius-xs); padding: 2px 5px; background: var(--surface-soft); color: var(--text); font: 14px/1.5 "SFMono-Regular",Consolas,monospace; }.markdown-body :global(pre) { max-width: 100%; overflow: auto; margin: 18px 0; border: 1px solid #303832; border-radius: var(--radius); padding: 15px 17px; background: #151c18; color: #cbd7cf; }.markdown-body :global(pre code) { border: 0; padding: 0; background: transparent; color: inherit; font-size: 14px; }.markdown-body :global(a) { color: var(--active-text); text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }.markdown-body :global(a:hover) { color: var(--brand-600); }.markdown-body :global(hr) { margin: 28px 0; border: 0; border-top: 1px solid var(--border); }.markdown-body :global(table) { width: 100%; margin: 20px 0; border-collapse: collapse; font-size: 14px; }.markdown-body :global(th),.markdown-body :global(td) { border: 1px solid var(--border); padding: 8px 10px; text-align: left; }.markdown-body :global(th) { background: var(--surface-soft); color: var(--text); }
  .markdown-body :global(.mermaid-diagram) { display: grid; max-width: 100%; max-height: min(520px,60vh); min-height: 96px; place-items: center; overflow: auto; margin: 22px 0; border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 16px; background: var(--surface-soft); }.markdown-body :global(.mermaid-diagram svg) { width: auto !important; max-width: min(100%,760px) !important; height: auto !important; max-height: 470px !important; }.document-open .task-pane .markdown-body :global(.mermaid-diagram) { max-height: min(360px,48vh); padding: 12px; }.document-open .task-pane .markdown-body :global(.mermaid-diagram svg) { max-width: min(100%,520px) !important; max-height: 330px !important; }.markdown-body :global(.mermaid-diagram-error) { place-items: start; background: #151c18; color: #cbd7cf; font: 14px/1.6 "SFMono-Regular",Consolas,monospace; white-space: pre-wrap; }.mermaid-notice { margin: -44px auto 26px; max-width: 824px; border: 1px solid color-mix(in srgb,var(--warning-500) 55%,var(--border)); border-radius: var(--radius); padding: 10px 12px; background: var(--warning-surface); color: var(--warning-600); font-size: 13px; }
  .content-empty { display: grid; min-height: 100%; place-items: center; align-content: center; padding: 48px; text-align: center; }.empty-document { display: grid; width: 64px; height: 64px; place-items: center; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface-soft); color: var(--brand-500); }.empty-document svg { width: 29px; height: 29px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.7; }.empty-eyebrow { margin: 18px 0 3px; color: var(--active-text); font-size: 11px; font-weight: 800; letter-spacing: .09em; text-transform: uppercase; }.content-empty h3 { margin: 0; font-size: 19px; }.content-empty > p:not(.empty-eyebrow) { max-width: 460px; margin: 9px 0 19px; color: var(--text-muted); font-size: 13px; line-height: 1.6; }.content-empty button { min-height: 40px; border: 1px solid var(--brand-600); border-radius: var(--radius); padding: 0 14px; background: var(--brand-600); color: white; font-size: 12px; font-weight: 750; }.content-empty button:disabled { opacity: .5; }
  .content-stream { overflow: hidden; margin: 0 24px 28px; border: 1px solid #34423b; border-radius: var(--radius); background: #111815; color: #c6d1ca; }.content-stream > header { display: flex; align-items: center; gap: 8px; border-bottom: 1px solid #2b3832; padding: 9px 11px; background: #161f1b; }.content-stream > header span { width: 8px; height: 8px; border-radius: 50%; background: #e0aa62; }.content-stream[data-status="running"] > header span { animation: pulse 1.2s ease infinite; }.content-stream[data-status="failed"] > header span { background: #d36b64; }.content-stream strong { font-size: 11px; }.content-stream pre { max-height: 220px; overflow: auto; margin: 0; padding: 12px; color: #9eaaa2; font: 11px/1.6 "SFMono-Regular",Consolas,monospace; white-space: pre-wrap; word-break: break-word; }
  .panel-footer { display: flex; min-height: 66px; align-items: center; justify-content: space-between; gap: 18px; border-top: 1px solid var(--border); padding: 10px 16px 10px 20px; background: color-mix(in srgb,var(--surface) 96%,transparent); backdrop-filter: blur(12px); }.panel-footer > div:first-child { min-width: 0; }.panel-footer span,.panel-footer code { display: block; }.panel-footer > div:first-child > span { color: var(--text-subtle); font-size: 10px; font-weight: 750; letter-spacing: .06em; text-transform: uppercase; }.panel-footer code { overflow: hidden; margin-top: 3px; border: 0; padding: 0; background: transparent; color: var(--text-muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }.panel-actions { display: flex; flex: 0 0 auto; gap: 8px; }.edit-button,.run-button { display: flex; min-height: 39px; flex: 0 0 auto; align-items: center; gap: 8px; border: 1px solid var(--border); border-radius: var(--radius); padding: 0 13px; background: var(--surface); color: var(--text); font-size: 12px; font-weight: 750; }.edit-button:hover { border-color: var(--brand-300); background: var(--active-surface); color: var(--active-text); }.run-button { border-color: var(--brand-600); background: var(--brand-600); color: white; }.run-button:hover { background: var(--brand-700); }.run-button:disabled { cursor: not-allowed; opacity: .45; }.edit-button svg,.run-button svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.8; }
  .repository-document { display: grid; min-width: 0; min-height: 0; grid-template-rows: 64px minmax(0,1fr); overflow: hidden; border-left: 1px solid var(--border); background: var(--surface); box-shadow: -12px 0 28px rgba(22,24,28,.07); animation: document-in .2s cubic-bezier(.2,.76,.2,1); }
  .document-header { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 14px; border-bottom: 1px solid var(--border); padding: 10px 12px 10px 16px; background: var(--surface-soft); }
  .document-heading { display: flex; min-width: 0; align-items: center; gap: 10px; }.document-glyph { display: grid; width: 34px; height: 34px; flex: 0 0 34px; place-items: center; border: 1px solid var(--brand-200); border-radius: var(--radius-sm); background: var(--active-surface); color: var(--active-text); }.document-glyph svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.7; }.document-heading > div { min-width: 0; }.document-heading small,.document-heading strong { display: block; }.document-heading small { margin-bottom: 3px; color: var(--active-text); font-size: 9px; font-weight: 800; letter-spacing: .09em; text-transform: uppercase; }.document-heading strong { overflow: hidden; color: var(--text); font: 650 11px/1.3 "SFMono-Regular",Consolas,monospace; text-overflow: ellipsis; white-space: nowrap; }
  .document-close { display: grid; width: 34px; height: 34px; flex: 0 0 34px; place-items: center; border: 1px solid transparent; border-radius: var(--radius-sm); background: transparent; color: var(--text-muted); font-size: 22px; line-height: 1; }.document-close:hover { border-color: var(--border); background: var(--surface); color: var(--text); }
  .document-body { min-height: 0; overflow: auto; overscroll-behavior: contain; background: color-mix(in srgb,var(--surface) 98%,var(--canvas)); }.document-markdown { max-width: 920px; padding: 36px 28px 70px; font-size: 16px; line-height: 1.72; }.document-markdown :global(h1) { font-size: 29px; }.document-markdown :global(h2) { font-size: 22px; }.document-markdown :global(h3) { font-size: 18px; }.document-markdown :global(h4) { font-size: 16px; }.document-mermaid-notice { margin: -48px 28px 26px; max-width: none; }
  .document-source { min-height: 100%; overflow: auto; margin: 0; padding: 24px 26px 64px; background: var(--surface); color: var(--text-muted); white-space: pre-wrap; word-break: break-word; }.document-source code { font: 12px/1.65 "SFMono-Regular",Consolas,monospace; }
  .document-state { display: grid; min-height: 100%; place-content: center; justify-items: center; padding: 30px; color: var(--text-muted); text-align: center; }.document-state strong { color: var(--text); font-size: 13px; }.document-state p { max-width: 460px; margin: 5px 0 0; color: var(--text-subtle); font-size: 11px; line-height: 1.55; }.document-state button { margin-top: 14px; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 7px 11px; background: var(--surface-soft); color: var(--text); font-size: 11px; }.document-state button:hover { border-color: var(--brand-300); background: var(--active-surface); color: var(--active-text); }.document-spinner { width: 20px; height: 20px; margin-bottom: 10px; border: 2px solid var(--border); border-top-color: var(--brand-500); border-radius: 50%; animation: document-spin .8s linear infinite; }.document-alert { display: grid; width: 28px; height: 28px; margin-bottom: 10px; place-items: center; border-radius: 50%; background: var(--warning-surface); color: var(--warning-600); font-weight: 850; }.document-failure p { color: var(--warning-600); }
  @keyframes panel-in { from { opacity: .7; transform: translateX(28px); } } @keyframes backdrop-in { from { opacity: 0; } }
  @keyframes document-in { from { opacity: 0; transform: translateX(18px); } }
  @keyframes document-spin { to { transform: rotate(360deg); } }
  @keyframes pulse { 50% { opacity: .35; transform: scale(.72); } }
  @media (max-width: 1240px) { .document-open .repository-document { position: absolute; z-index: 2; top: 0; right: 0; bottom: 0; width: min(720px,calc(100vw - 24px)); border-left: 1px solid var(--border); } }
  @media (max-width: 1100px) { .content-panel { --task-pane-width: min(900px,calc(100vw - 80px)); }.markdown-body { padding-inline: 24px; } }
  @media (max-width: 900px) { .content-panel { --task-pane-width: min(780px,calc(100vw - 40px)); }.markdown-body { padding-inline: 20px; } }
  @media (max-width: 620px) { .content-panel { --task-pane-width: 100vw; }.document-open .repository-document { width: 100vw; border-left: 0; }.panel-header { padding-left: 14px; }.task-glyph { display: none; }.task-heading h2 { font-size: 15px; }.task-context { padding-inline: 14px; }.markdown-body { padding: 24px 14px 54px; }.panel-footer { align-items: stretch; flex-direction: column; }.panel-actions { width: 100%; }.edit-button,.run-button { flex: 1; justify-content: center; }.content-empty { padding: 28px; } }
  @media (prefers-reduced-motion: reduce) { .content-panel,.panel-backdrop,.repository-document,.document-spinner { animation: none; } }
</style>
