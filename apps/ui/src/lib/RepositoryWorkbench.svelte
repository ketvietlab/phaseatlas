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

  function languageFor(path: string) {
    const extension = path.split(".").pop()?.toLowerCase();
    return ({ md: "markdown", json: "json", yaml: "yaml", yml: "yaml", ts: "typescript", js: "javascript", css: "css", html: "html", svelte: "html" } as Record<string, string>)[extension ?? ""] ?? "plaintext";
  }
</script>

<div class="ide-shell" role="dialog" aria-modal="true" aria-label="Repository editor">
  <header class="ide-titlebar">
    <div class="ide-product"><span class="ide-mark">PA</span><div><strong>Repository editor</strong><small>{checkoutId.slice(0, 8).toUpperCase()} · Monaco</small></div></div>
    <div class="ide-title-actions">
      {#if dirtyCount}<span class="dirty-summary">{dirtyCount} unsaved</span>{/if}
      <button type="button" onclick={saveActive} disabled={!activeTab || activeTab.content === activeTab.savedContent || saving}>{saving ? "Saving…" : "Save"}</button>
      <button class="ide-close" type="button" aria-label="Close repository editor" onclick={requestClose}>×</button>
    </div>
  </header>
  <div class="ide-body">
    <aside class="explorer-pane">
      <header><div><span>Explorer</span><strong>Repository</strong></div><button type="button" title="Refresh explorer" onclick={loadRoot}>↻</button></header>
      <div class="tree" role="tree">
        {#each rows as row}
          <button
            class:active={row.path === activePath}
            class="tree-row"
            style={`--depth:${row.depth}`}
            type="button"
            onclick={() => row.type === "directory" ? toggleDirectory(row) : openFile(row.path)}
          >
            <span class="tree-chevron">{row.type === "directory" ? loadingPaths.has(row.path) ? "·" : expanded.has(row.path) ? "⌄" : "›" : ""}</span>
            <span class="tree-icon">{row.type === "directory" ? expanded.has(row.path) ? "▾" : "▸" : row.name.endsWith(".md") ? "M↓" : "·"}</span>
            <span>{row.name}</span>
          </button>
        {/each}
      </div>
    </aside>
    <main class="editor-pane">
      <div class="editor-tabs">
        {#each tabs as tab}
          <div class:active={tab.path === activePath} class="editor-tab">
            <button class="tab-select" type="button" onclick={() => activePath = tab.path}>
              <span>{tab.path.split("/").pop()}</span>{#if tab.content !== tab.savedContent}<i></i>{/if}
            </button>
            <button class="tab-close" type="button" aria-label={`Close ${tab.path}`} onclick={() => closeTab(tab.path)}>×</button>
          </div>
        {/each}
      </div>
      {#if error}<div class="ide-error">{error}</div>{/if}
      {#if activeTab}
        <div class="editor-breadcrumb">{activeTab.path.replaceAll("/", "  ›  ")}</div>
        <div class="editor-surface">
          <MonacoEditor value={activeTab.content} language={languageFor(activeTab.path)} {theme} onChange={updateActiveContent} onSave={saveActive} />
        </div>
        <footer class="editor-status"><span>{languageFor(activeTab.path)}</span><span>UTF-8</span><span>⌘S to save</span></footer>
      {:else}
        <div class="editor-empty"><span>PA</span><h2>Open a file from Explorer</h2><p>Task bodies are stored as Markdown beside their canonical YAML contracts.</p></div>
      {/if}
    </main>
  </div>
</div>

<style>
  .ide-shell { position: fixed; z-index: 120; inset: 0; display: grid; grid-template-rows: 52px minmax(0,1fr); background: #1e1f22; color: #d7d9dc; }
  .ide-titlebar { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #303238; padding: 0 14px; background: #25262a; -webkit-app-region: drag; }
  .ide-product,.ide-title-actions { display: flex; align-items: center; gap: 10px; }.ide-mark { display: grid; width: 30px; height: 30px; place-items: center; border-radius: 7px; background: #637ad5; color: white; font-size: 10px; font-weight: 800; }.ide-product strong,.ide-product small { display: block; }.ide-product strong { font-size: 12px; }.ide-product small { color: #858a92; font-size: 10px; }
  .ide-title-actions { -webkit-app-region: no-drag; }.ide-title-actions button { min-height: 32px; border: 1px solid #41444c; border-radius: 6px; padding: 5px 11px; background: #2d2f34; color: #d9dbe0; font-size: 11px; }.ide-title-actions button:disabled { opacity: .4; }.ide-title-actions .ide-close { width: 32px; padding: 0; font-size: 20px; }.dirty-summary { color: #e0aa62; font-size: 10px; }
  .ide-body { display: grid; min-height: 0; grid-template-columns: 250px minmax(0,1fr); }.explorer-pane { min-width: 0; overflow: hidden; border-right: 1px solid #303238; background: #242529; }.explorer-pane > header { display: flex; height: 52px; align-items: center; justify-content: space-between; padding: 7px 10px 7px 14px; }.explorer-pane header span,.explorer-pane header strong { display: block; }.explorer-pane header span { color: #81858d; font-size: 9px; letter-spacing: .12em; text-transform: uppercase; }.explorer-pane header strong { margin-top: 2px; font-size: 11px; text-transform: uppercase; }.explorer-pane header button { border: 0; background: transparent; color: #8d929b; font-size: 16px; }
  .tree { height: calc(100% - 52px); overflow: auto; }.tree-row { display: grid; width: 100%; min-height: 30px; grid-template-columns: 14px 17px minmax(0,1fr); align-items: center; gap: 3px; border: 0; padding: 3px 8px 3px calc(8px + var(--depth) * 14px); background: transparent; color: #c2c5ca; font-size: 13px; text-align: left; }.tree-row:hover { background: #2c2e33; }.tree-row.active { background: #373a42; color: #fff; }.tree-chevron { color: #767b84; font-size: 15px; }.tree-icon { color: #9ba4bd; font-size: 10px; font-weight: 800; }
  .editor-pane { display: grid; min-width: 0; min-height: 0; grid-template-rows: 36px auto minmax(0,1fr) 24px; background: #1e1f22; }.editor-tabs { display: flex; overflow-x: auto; border-bottom: 1px solid #303238; background: #242529; }.editor-tab { display: flex; min-width: 130px; max-width: 220px; border-right: 1px solid #303238; background: #292a2e; color: #9499a1; }.editor-tab.active { border-top: 1px solid #637ad5; background: #1e1f22; color: #e4e5e8; }.tab-select { display: flex; min-width: 0; flex: 1; align-items: center; gap: 7px; border: 0; padding: 0 4px 0 12px; background: transparent; color: inherit; font-size: 11px; }.tab-select span { overflow: hidden; flex: 1; text-overflow: ellipsis; white-space: nowrap; }.tab-select i { width: 7px; height: 7px; border-radius: 50%; background: #e0aa62; }.tab-close { width: 28px; border: 0; background: transparent; color: inherit; font-size: 14px; }.editor-breadcrumb { padding: 6px 14px; color: #858a92; font-size: 10px; }.editor-surface { min-height: 0; }.editor-status { display: flex; align-items: center; justify-content: flex-end; gap: 14px; padding: 0 10px; background: #3d4e91; color: #f3f5ff; font-size: 9px; text-transform: capitalize; }.editor-empty { display: grid; grid-row: 2 / 5; place-items: center; align-content: center; color: #777c84; text-align: center; }.editor-empty > span { color: #353841; font-size: 72px; font-weight: 850; letter-spacing: -.08em; }.editor-empty h2 { margin: 8px 0 4px; color: #a8acb3; font-size: 15px; }.editor-empty p { margin: 0; font-size: 11px; }.ide-error { padding: 7px 12px; background: #503532; color: #f2c3be; font-size: 10px; }
  @media (max-width: 760px) { .ide-body { grid-template-columns: 190px minmax(0,1fr); } }
</style>
