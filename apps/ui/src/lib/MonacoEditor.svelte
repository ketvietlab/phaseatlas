<script lang="ts">
  import { onMount } from "svelte";
  import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";

  export let value = "";
  export let language = "markdown";
  export let theme: "light" | "dark" = "light";
  export let onChange: (value: string) => void = () => undefined;
  export let onSave: () => void = () => undefined;
  export let onToggleTerminal: () => void = () => undefined;

  type MonacoApi = typeof import("monaco-editor");

  let host: HTMLDivElement;
  let editor: import("monaco-editor").editor.IStandaloneCodeEditor | null = null;
  let monacoApi: MonacoApi | null = null;
  let applyingExternalValue = false;

  function editorThemeName(activeTheme: "light" | "dark") {
    return `phaseatlas-${activeTheme}`;
  }

  function phaseAtlasColor(name: string, fallback: string) {
    const color = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const resolved = color || fallback;
    const shortHex = resolved.match(/^#([0-9a-f]{3})$/i)?.[1];
    if (shortHex) return `#${shortHex.split("").map((value) => `${value}${value}`).join("")}`;
    return resolved;
  }

  function tokenColor(color: string) {
    const hex = color.startsWith("#") ? color.slice(1) : color;
    if (/^[0-9a-f]{3}$/i.test(hex)) return hex.split("").map((value) => `${value}${value}`).join("");
    if (/^[0-9a-f]{6}$/i.test(hex)) return hex;
    const channels = color.match(/[\d.]+/g)?.slice(0, 3).map((value) => Number(value));
    return channels?.length === 3
      ? channels.map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0")).join("")
      : "717373";
  }

  function applyEditorTheme(activeTheme: "light" | "dark") {
    if (!monacoApi) return;
    const palette = {
      surface: phaseAtlasColor("--surface", activeTheme === "dark" ? "#2e3034" : "#ffffff"),
      surfaceSoft: phaseAtlasColor("--surface-soft", activeTheme === "dark" ? "#24262a" : "#f7f5f5"),
      border: phaseAtlasColor("--border", activeTheme === "dark" ? "#44464a" : "#dddcde"),
      text: phaseAtlasColor("--text", activeTheme === "dark" ? "#f7f5f5" : "#24262a"),
      muted: phaseAtlasColor("--text-muted", activeTheme === "dark" ? "#cccccd" : "#5a5c5e"),
      subtle: phaseAtlasColor("--text-subtle", "#717373"),
      brand: phaseAtlasColor("--brand-600", "#5167c4"),
      brandSoft: phaseAtlasColor("--active-surface", activeTheme === "dark" ? "#2f3a5f" : "#eef0fb"),
      brandText: phaseAtlasColor("--active-text", activeTheme === "dark" ? "#dde2f7" : "#45579f"),
      success: phaseAtlasColor("--success-text", activeTheme === "dark" ? "#ecf5ef" : "#1d5d3b"),
      warning: phaseAtlasColor("--warning-600", "#b8711d"),
    };

    monacoApi.editor.defineTheme(editorThemeName(activeTheme), {
      base: activeTheme === "dark" ? "vs-dark" : "vs",
      inherit: true,
      rules: [
        { token: "comment", foreground: tokenColor(palette.subtle), fontStyle: "italic" },
        { token: "keyword", foreground: tokenColor(palette.brandText) },
        { token: "string", foreground: tokenColor(palette.success) },
        { token: "number", foreground: tokenColor(palette.warning) },
        { token: "type", foreground: tokenColor(palette.brandText) },
        { token: "delimiter", foreground: tokenColor(palette.muted) },
        { token: "markup.heading", foreground: tokenColor(palette.brandText), fontStyle: "bold" },
        { token: "markup.bold", foreground: tokenColor(palette.text), fontStyle: "bold" },
      ],
      colors: {
        "editor.background": palette.surface,
        "editor.foreground": palette.text,
        "editorGutter.background": palette.surface,
        "editorLineNumber.foreground": palette.subtle,
        "editorLineNumber.activeForeground": palette.brandText,
        "editorCursor.foreground": palette.brand,
        "editor.selectionBackground": palette.brandSoft,
        "editor.inactiveSelectionBackground": palette.surfaceSoft,
        "editor.lineHighlightBackground": palette.surfaceSoft,
        "editorLineHighlightBorder": palette.border,
        "editorIndentGuide.background1": palette.border,
        "editorIndentGuide.activeBackground1": palette.brand,
        "editorWhitespace.foreground": palette.border,
        "editorWidget.background": palette.surface,
        "editorWidget.border": palette.border,
        "editorSuggestWidget.background": palette.surface,
        "editorSuggestWidget.border": palette.border,
        "editorSuggestWidget.foreground": palette.text,
        "editorSuggestWidget.selectedBackground": palette.brandSoft,
        "scrollbarSlider.background": `${palette.subtle}44`,
        "scrollbarSlider.hoverBackground": `${palette.subtle}66`,
        "scrollbarSlider.activeBackground": `${palette.subtle}88`,
      },
    });
    monacoApi.editor.setTheme(editorThemeName(activeTheme));
  }

  function applyEditorLanguage(activeLanguage: string) {
    const model = editor?.getModel();
    if (!monacoApi || !model || model.getLanguageId() === activeLanguage) return;
    monacoApi.editor.setModelLanguage(model, activeLanguage);
  }

  export function focus() {
    editor?.focus();
  }

  onMount(() => {
    let disposed = false;
    (window as typeof window & { MonacoEnvironment?: unknown }).MonacoEnvironment = {
      getWorker: () => new EditorWorker(),
    };
    void import("monaco-editor/editor/editor.main.js").then((monaco) => {
      if (disposed) return;
      monacoApi = monaco;
      applyEditorTheme(theme);
      const instance = monaco.editor.create(host, {
        value,
        language,
        theme: editorThemeName(theme),
        automaticLayout: true,
        wordWrap: "on",
        wrappingIndent: "indent",
        minimap: { enabled: false },
        fontFamily: '"SFMono-Regular", Menlo, Monaco, Consolas, monospace',
        fontSize: 13,
        lineHeight: 21,
        lineNumbersMinChars: 3,
        foldingHighlight: true,
        renderLineHighlight: "all",
        overviewRulerBorder: false,
        hideCursorInOverviewRuler: true,
        padding: { top: 16, bottom: 20 },
        renderWhitespace: "selection",
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        stickyScroll: { enabled: true, maxLineCount: 4 },
        tabSize: 2,
      });
      editor = instance;
      instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSave());
      instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Backquote, () => onToggleTerminal());
      instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyJ, () => onToggleTerminal());
      instance.onDidChangeModelContent(() => {
        if (!applyingExternalValue) onChange(editor?.getValue() ?? "");
      });
    });
    return () => {
      disposed = true;
      editor?.dispose();
      editor = null;
      monacoApi = null;
    };
  });

  $: if (editor && editor.getValue() !== value) {
    applyingExternalValue = true;
    editor.setValue(value);
    applyingExternalValue = false;
  }
  $: if (monacoApi && editor) applyEditorLanguage(language);
  $: if (monacoApi) applyEditorTheme(theme);
</script>

<div class="monaco-host" bind:this={host}></div>

<style>
  .monaco-host { width: 100%; height: 100%; min-height: 0; background: var(--surface); }
</style>
