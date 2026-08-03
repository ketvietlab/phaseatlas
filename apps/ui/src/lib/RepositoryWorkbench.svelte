<script lang="ts">
  import { onMount } from "svelte";
  import type { RepositoryFileDocument, RepositoryFileEntry } from "@phaseatlas/contracts";
  import MonacoEditor from "./MonacoEditor.svelte";

  export let checkoutId: string;
  export let initialPath = "";
  export let theme: "light" | "dark" = "light";
  export let onClose: () => void = () => undefined;
  export let onSaved: (path: string) => void = () => undefined;

  type TreeRow = RepositoryFileEntry & { depth: number; parent: string };
  type EditorTab = RepositoryFileDocument & { savedContent: string };

  let rows: TreeRow[] = [];
  let expanded = new Set<string>();
  let loadingPaths = new Set<string>();
  let tabs: EditorTab[] = [];
  let activePath = "";
  let error = "";
  let saving = false;

  $: activeTab = tabs.find((tab) => tab.path === activePath);
  $: dirtyCount = tabs.filter((tab) => tab.content !== tab.savedContent).length;

  onMount(() => {
    void loadRoot();
    if (initialPath) void openFile(initialPath);
  });

  async function loadRoot() {
    if (!window.phaseatlas) return;
    error = "";
    try {
      const entries = await window.phaseatlas.files.list(checkoutId);
      rows = entries.map((entry) => ({ ...entry, depth: 0, parent: "" }));
      expanded = new Set();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "The repository tree could not be loaded.";
    }
  }

  async function toggleDirectory(row: TreeRow) {
    if (!window.phaseatlas) return;
    if (expanded.has(row.path)) {
      const nextExpanded = new Set(expanded);
      nextExpanded.delete(row.path);
      expanded = nextExpanded;
      rows = rows.filter((candidate) => !candidate.path.startsWith(`${row.path}/`) || candidate.depth <= row.depth);
      return;
    }
    loadingPaths = new Set(loadingPaths).add(row.path);
    try {
      const entries = await window.phaseatlas.files.list(checkoutId, row.path);
      const index = rows.findIndex((candidate) => candidate.path === row.path);
      rows = [
        ...rows.slice(0, index + 1),
        ...entries.map((entry) => ({ ...entry, depth: row.depth + 1, parent: row.path })),
        ...rows.slice(index + 1),
      ];
      expanded = new Set(expanded).add(row.path);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : `Could not open ${row.path}.`;
    } finally {
      const next = new Set(loadingPaths);
      next.delete(row.path);
      loadingPaths = next;
    }
  }

  async function openFile(path: string) {
    if (!window.phaseatlas) return;
    const existing = tabs.find((tab) => tab.path === path);
    if (existing) {
      activePath = path;
      return;
    }
    error = "";
    try {
      const document = await window.phaseatlas.files.read(checkoutId, path);
      tabs = [...tabs, { ...document, savedContent: document.content }];
      activePath = path;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : `${path} could not be opened.`;
    }
  }

  function updateActiveContent(content: string) {
    tabs = tabs.map((tab) => tab.path === activePath ? { ...tab, content } : tab);
  }

  async function saveActive() {
    if (!window.phaseatlas || !activeTab || activeTab.content === activeTab.savedContent || saving) return;
    saving = true;
    error = "";
    try {
      await window.phaseatlas.files.save(checkoutId, activeTab.path, activeTab.content);
      tabs = tabs.map((tab) => tab.path === activeTab?.path
        ? { ...tab, savedContent: tab.content }
        : tab);
      onSaved(activeTab.path);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : `${activeTab.path} could not be saved.`;
    } finally {
      saving = false;
    }
  }

  function closeTab(path: string) {
    const tab = tabs.find((candidate) => candidate.path === path);
    if (tab?.content !== tab?.savedContent && !window.confirm(`Discard unsaved changes in ${path}?`)) return;
    const index = tabs.findIndex((candidate) => candidate.path === path);
    tabs = tabs.filter((candidate) => candidate.path !== path);
    if (activePath === path) activePath = tabs[Math.max(index - 1, 0)]?.path ?? "";
  }

  function requestClose() {
    if (dirtyCount && !window.confirm(`Discard unsaved changes in ${dirtyCount} file${dirtyCount === 1 ? "" : "s"}?`)) return;
    onClose();
  }

  export function closeActiveSurface() {
    if (activePath) {
      closeTab(activePath);
      return;
    }
    requestClose();
  }

  function languageFor(path: string) {
    const fileName = path.split("/").pop()?.toLowerCase() ?? "";
    const namedLanguages: Record<string, string> = {
      dockerfile: "dockerfile",
      makefile: "plaintext",
    };
    if (namedLanguages[fileName]) return namedLanguages[fileName];
    const extension = path.split(".").pop()?.toLowerCase();
    return ({
      bash: "shell",
      c: "cpp",
      cc: "cpp",
      cjs: "javascript",
      cpp: "cpp",
      cs: "csharp",
      css: "css",
      go: "go",
      h: "cpp",
      hpp: "cpp",
      html: "html",
      java: "java",
      js: "javascript",
      json: "json",
      jsx: "javascript",
      less: "less",
      lua: "lua",
      md: "markdown",
      mdx: "mdx",
      mjs: "javascript",
      php: "php",
      prisma: "graphql",
      py: "python",
      rb: "ruby",
      rs: "rust",
      scss: "scss",
      sh: "shell",
      sql: "sql",
      svelte: "html",
      swift: "swift",
      toml: "ini",
      ts: "typescript",
      tsx: "typescript",
      vue: "html",
      xml: "xml",
      yaml: "yaml",
      yml: "yaml",
      zsh: "shell",
    } as Record<string, string>)[extension ?? ""] ?? "plaintext";
  }

  function fileLabel(row: RepositoryFileEntry) {
    if (row.type === "directory") return "";
    const extension = row.name.includes(".") ? row.name.split(".").pop()?.toUpperCase() : "";
    return extension?.slice(0, 2) || "·";
  }
</script>

<div class="ide-shell" data-theme={theme} role="dialog" aria-modal="true" aria-label="Repository editor">
  <header class="ide-titlebar">
    <div class="ide-product">
      <img class="ide-mark" src="/assets/phaseatlas-logo-mark.png" alt="" />
      <div>
        <strong>Repository editor</strong>
        <small>PhaseAtlas · {checkoutId.slice(0, 8).toUpperCase()}</small>
      </div>
    </div>
    <div class="ide-title-actions">
      {#if dirtyCount}<span class="dirty-summary"><i></i>{dirtyCount} unsaved</span>{/if}
      <button class="save-button" type="button" onclick={saveActive} disabled={!activeTab || activeTab.content === activeTab.savedContent || saving}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h12l2 2v14H5zM8 4v6h8V4M8 20v-6h8v6" /></svg>
        {saving ? "Saving…" : "Save"}
      </button>
      <button class="icon-button ide-close" type="button" aria-label="Close repository editor" title="Close editor" onclick={requestClose}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
      </button>
    </div>
  </header>
  <div class="ide-body">
    <aside class="explorer-pane">
      <header class="explorer-header">
        <div><span>Workspace</span><strong>Repository files</strong></div>
        <button class="icon-button" type="button" aria-label="Refresh explorer" title="Refresh explorer" onclick={loadRoot}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" /></svg>
        </button>
      </header>
      <div class="tree" role="tree">
        {#each rows as row}
          <button
            class:active={row.path === activePath}
            class="tree-row"
            style={`--depth:${row.depth}`}
            type="button"
            role="treeitem"
            aria-selected={row.path === activePath}
            aria-expanded={row.type === "directory" ? expanded.has(row.path) : undefined}
            onclick={() => row.type === "directory" ? toggleDirectory(row) : openFile(row.path)}
          >
            <span class:loading={loadingPaths.has(row.path)} class:expanded={expanded.has(row.path)} class="tree-chevron">
              {#if row.type === "directory"}
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 3 5 5-5 5" /></svg>
              {/if}
            </span>
            <span class:folder={row.type === "directory"} class="tree-icon">
              {#if row.type === "directory"}
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 5.5h6l1.5 2h7.5v8.5h-15z" /></svg>
              {:else}
                {fileLabel(row)}
              {/if}
            </span>
            <span class="tree-name">{row.name}</span>
          </button>
        {/each}
        {#if !rows.length && !error}<p class="tree-empty">This repository has no visible files.</p>{/if}
      </div>
    </aside>
    <main class="editor-pane">
      <div class="editor-tabs" role="tablist" aria-label="Open files">
        {#each tabs as tab}
          <div class:active={tab.path === activePath} class="editor-tab">
            <button class="tab-select" type="button" role="tab" aria-selected={tab.path === activePath} onclick={() => activePath = tab.path}>
              <span class="tab-file-badge">{tab.path.split(".").pop()?.slice(0, 2).toUpperCase() || "·"}</span>
              <span>{tab.path.split("/").pop()}</span>{#if tab.content !== tab.savedContent}<i title="Unsaved changes"></i>{/if}
            </button>
            <button class="tab-close" type="button" aria-label={`Close ${tab.path}`} onclick={() => closeTab(tab.path)}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
            </button>
          </div>
        {/each}
        {#if !tabs.length}<span class="tabs-empty">No open files</span>{/if}
      </div>
      {#if error}<div class="ide-error" role="alert"><strong>Editor issue</strong><span>{error}</span></div>{/if}
      {#if activeTab}
        <div class="editor-context">
          <nav class="editor-breadcrumb" aria-label="Current file">{activeTab.path.replaceAll("/", "  ›  ")}</nav>
          <span>{activeTab.content.length.toLocaleString()} chars</span>
        </div>
        <div class="editor-surface">
          <MonacoEditor value={activeTab.content} language={languageFor(activeTab.path)} {theme} onChange={updateActiveContent} onSave={saveActive} />
        </div>
        <footer class="editor-status">
          <span class:dirty={activeTab.content !== activeTab.savedContent}><i></i>{activeTab.content !== activeTab.savedContent ? "Modified" : "Saved"}</span>
          <span class="status-spacer"></span>
          <span>{languageFor(activeTab.path)}</span><span>UTF-8</span><span>⌘S to save</span>
        </footer>
      {:else}
        <div class="editor-empty">
          <img src="/assets/phaseatlas-logo-mark.png" alt="" />
          <p class="empty-eyebrow">Repository workbench</p>
          <h2>Open a file from Explorer</h2>
          <p>Review task bodies and nearby source files without leaving PhaseAtlas.</p>
        </div>
      {/if}
    </main>
  </div>
</div>

<style>
  .ide-shell {
    position: fixed;
    z-index: 120;
    inset: 0;
    display: grid;
    grid-template-rows: 58px minmax(0, 1fr);
    background: var(--canvas);
    color: var(--text);
  }

  .ide-titlebar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--border);
    padding: 0 14px 0 18px;
    background: color-mix(in srgb, var(--surface) 94%, transparent);
    box-shadow: var(--shadow-card);
    backdrop-filter: blur(14px);
    -webkit-app-region: drag;
  }

  .ide-product,
  .ide-title-actions,
  .dirty-summary,
  .save-button,
  .editor-status > span {
    display: flex;
    align-items: center;
  }

  .ide-product { gap: 10px; }
  .ide-mark { width: 32px; height: 32px; flex: 0 0 32px; object-fit: contain; }
  .ide-product strong,
  .ide-product small { display: block; }
  .ide-product strong { font-size: 13px; font-weight: 750; letter-spacing: -.015em; }
  .ide-product small { margin-top: 1px; color: var(--text-subtle); font-size: 9px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }

  .ide-title-actions { gap: 8px; -webkit-app-region: no-drag; }
  .dirty-summary { gap: 6px; margin-right: 3px; border-radius: var(--radius-full); padding: 4px 8px; background: var(--warning-surface); color: var(--warning-600); font-size: 10px; font-weight: 750; }
  .ide-shell[data-theme="dark"] .dirty-summary { color: var(--warning-text); }
  .dirty-summary i,
  .editor-status i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .save-button { min-height: 34px; gap: 7px; border: 1px solid var(--brand-600); border-radius: var(--radius-sm); padding: 5px 11px; background: var(--brand-600); color: #fff; font-size: 11px; font-weight: 700; }
  .save-button:hover:not(:disabled) { border-color: var(--brand-700); background: var(--brand-700); }
  .save-button svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.8; }
  .icon-button { display: grid; width: 32px; height: 32px; place-items: center; border: 1px solid transparent; border-radius: var(--radius-sm); padding: 0; background: transparent; color: var(--text-muted); }
  .icon-button:hover { border-color: var(--border); background: var(--surface-soft); color: var(--text); }
  .icon-button svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.8; }
  .ide-close { margin-left: 2px; }

  .ide-body { display: grid; min-height: 0; grid-template-columns: 264px minmax(0, 1fr); }
  .explorer-pane { min-width: 0; overflow: hidden; border-right: 1px solid var(--border); background: var(--surface-soft); }
  .explorer-header { display: flex; height: 58px; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border-soft); padding: 8px 10px 8px 16px; }
  .explorer-header span,
  .explorer-header strong { display: block; }
  .explorer-header span { color: var(--active-text); font-size: 9px; font-weight: 800; letter-spacing: .11em; text-transform: uppercase; }
  .explorer-header strong { margin-top: 2px; color: var(--text); font-size: 11px; font-weight: 750; text-transform: uppercase; }

  .tree { height: calc(100% - 58px); overflow: auto; padding: 6px; }
  .tree-row { display: grid; width: 100%; min-height: 31px; grid-template-columns: 14px 20px minmax(0, 1fr); align-items: center; gap: 4px; border: 0; border-radius: var(--radius-sm); padding: 3px 8px 3px calc(7px + var(--depth) * 14px); background: transparent; color: var(--text-muted); font-size: 12px; text-align: left; }
  .tree-row:hover { background: var(--surface); color: var(--text); }
  .tree-row.active { background: var(--active-surface); color: var(--active-text); box-shadow: inset 3px 0 var(--brand-500); }
  .tree-chevron { display: grid; width: 14px; height: 14px; place-items: center; color: var(--text-subtle); transition: transform 140ms ease; }
  .tree-chevron.expanded { transform: rotate(90deg); }
  .tree-chevron.loading { animation: explorer-pulse 850ms ease-in-out infinite alternate; }
  .tree-chevron svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.7; }
  .tree-icon { display: grid; min-width: 19px; height: 18px; place-items: center; border-radius: var(--radius-xs); background: var(--surface-raised); color: var(--text-subtle); font: 800 8px/1 "SFMono-Regular", Consolas, monospace; letter-spacing: -.02em; }
  .tree-icon.folder { background: transparent; color: var(--active-text); }
  .tree-icon svg { width: 17px; height: 17px; fill: color-mix(in srgb, currentColor 18%, transparent); stroke: currentColor; stroke-linejoin: round; stroke-width: 1.3; }
  .tree-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tree-empty { margin: 18px 10px; color: var(--text-subtle); font-size: 11px; line-height: 1.5; }

  .editor-pane { display: grid; min-width: 0; min-height: 0; grid-template-rows: 40px auto minmax(0, 1fr) 26px; background: var(--surface); }
  .editor-tabs { display: flex; overflow-x: auto; border-bottom: 1px solid var(--border); background: var(--surface-soft); }
  .editor-tab { display: flex; min-width: 150px; max-width: 240px; border-right: 1px solid var(--border); background: var(--surface-soft); color: var(--text-subtle); }
  .editor-tab.active { position: relative; background: var(--surface); color: var(--text); }
  .editor-tab.active::before { position: absolute; top: 0; right: 0; left: 0; height: 2px; background: var(--brand-500); content: ""; }
  .tab-select { display: flex; min-width: 0; flex: 1; align-items: center; gap: 7px; border: 0; padding: 0 4px 0 11px; background: transparent; color: inherit; font-size: 11px; }
  .tab-select > span:not(.tab-file-badge) { overflow: hidden; flex: 1; text-overflow: ellipsis; white-space: nowrap; }
  .tab-file-badge { display: grid; width: 18px; height: 18px; flex: 0 0 18px; place-items: center; border-radius: var(--radius-xs); background: var(--surface-raised); color: var(--active-text); font: 800 8px/1 "SFMono-Regular", Consolas, monospace; }
  .tab-select i { width: 6px; height: 6px; flex: 0 0 6px; border-radius: 50%; background: var(--warning-500); }
  .tab-close { display: grid; width: 29px; flex: 0 0 29px; place-items: center; border: 0; padding: 0; background: transparent; color: inherit; }
  .tab-close:hover { background: var(--surface-raised); color: var(--text); }
  .tab-close svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-width: 1.5; }
  .tabs-empty { display: flex; align-items: center; padding: 0 13px; color: var(--text-subtle); font-size: 10px; font-weight: 650; text-transform: uppercase; }

  .editor-context { display: flex; min-height: 32px; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid var(--border-soft); padding: 5px 14px; background: var(--surface); color: var(--text-subtle); font-size: 10px; }
  .editor-breadcrumb { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .editor-context > span { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
  .editor-surface { min-height: 0; background: var(--surface); }
  .editor-status { display: flex; align-items: center; gap: 14px; border-top: 1px solid var(--border); padding: 0 11px; background: var(--active-surface); color: var(--active-text); font-size: 9px; font-weight: 650; text-transform: capitalize; }
  .editor-status > span { gap: 5px; }
  .editor-status > span:first-child i { background: var(--success-500); }
  .editor-status > span:first-child.dirty { color: var(--warning-600); }
  .editor-status > span:first-child.dirty i { background: currentColor; }
  .status-spacer { flex: 1; }

  .editor-empty { display: grid; grid-row: 2 / 5; place-items: center; align-content: center; padding: 30px; color: var(--text-muted); text-align: center; }
  .editor-empty img { width: 76px; height: 76px; margin-bottom: 18px; object-fit: contain; filter: saturate(.75); opacity: .18; }
  .empty-eyebrow { margin: 0 0 4px; color: var(--active-text); font-size: 9px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
  .editor-empty h2 { margin: 0 0 5px; color: var(--text); font-size: 16px; font-weight: 750; letter-spacing: -.015em; }
  .editor-empty p:last-child { max-width: 420px; margin: 0; color: var(--text-subtle); font-size: 11px; line-height: 1.55; }
  .ide-error { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px; border-bottom: 1px solid color-mix(in srgb, var(--warning-500) 55%, var(--border)); padding: 8px 12px; background: var(--warning-surface); color: var(--warning-text); font-size: 10px; }
  .ide-error strong { color: currentColor; }
  .ide-error span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  @keyframes explorer-pulse { to { opacity: .25; transform: rotate(90deg) scale(.7); } }
  @media (max-width: 760px) { .ide-body { grid-template-columns: 210px minmax(0, 1fr); } .ide-product small { display: none; } }
  @media (prefers-reduced-motion: reduce) { .tree-chevron { transition: none; } .tree-chevron.loading { animation-duration: 1.5s; } }
</style>
