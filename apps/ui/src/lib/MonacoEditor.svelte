<script lang="ts">
  import { onMount } from "svelte";
  import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";

  export let value = "";
  export let language = "markdown";
  export let theme: "light" | "dark" = "light";
  export let onChange: (value: string) => void = () => undefined;
  export let onSave: () => void = () => undefined;

  let host: HTMLDivElement;
  let editor: import("monaco-editor").editor.IStandaloneCodeEditor | null = null;
  let applyingExternalValue = false;

  onMount(() => {
    let disposed = false;
    (window as typeof window & { MonacoEnvironment?: unknown }).MonacoEnvironment = {
      getWorker: () => new EditorWorker(),
    };
    void import("monaco-editor/editor/editor.main.js").then((monaco) => {
      if (disposed) return;
      const instance = monaco.editor.create(host, {
        value,
        language,
        theme: theme === "dark" ? "vs-dark" : "vs",
        automaticLayout: true,
        wordWrap: "on",
        wrappingIndent: "indent",
        minimap: { enabled: false },
        fontFamily: '"SFMono-Regular", Menlo, Monaco, Consolas, monospace',
        fontSize: 13,
        lineHeight: 21,
        padding: { top: 14, bottom: 18 },
        renderWhitespace: "selection",
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        tabSize: 2,
      });
      editor = instance;
      instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSave());
      instance.onDidChangeModelContent(() => {
        if (!applyingExternalValue) onChange(editor?.getValue() ?? "");
      });
    });
    return () => {
      disposed = true;
      editor?.dispose();
      editor = null;
    };
  });

  $: if (editor && editor.getValue() !== value) {
    applyingExternalValue = true;
    editor.setValue(value);
    applyingExternalValue = false;
  }
  $: editor?.updateOptions({ theme: theme === "dark" ? "vs-dark" : "vs" });
</script>

<div class="monaco-host" bind:this={host}></div>

<style>
  .monaco-host { width: 100%; height: 100%; min-height: 0; }
</style>
