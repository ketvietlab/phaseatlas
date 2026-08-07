<script lang="ts">
  import SvelteMarkdown from "@humanspeak/svelte-markdown";

  export let source = "";

  // Model output is untrusted: links never resolve and images are never fetched,
  // matching how the chat transcript already renders the same kind of text.

  // Providers sometimes double-escape when asked for JSON, so the field arrives
  // holding the two characters \ and n instead of a newline. Only repair a string
  // that has no real newline at all — that is the double-escaped case. A text that
  // already breaks lines and also mentions \n is describing the sequence, and
  // rewriting it there would corrupt the meaning. Persisted evidence is untouched;
  // this is a rendering repair.
  function readable(value: string): string {
    if (!value.includes("\\n") || /\r|\n/.test(value)) return value;
    return value.replace(/\\r\\n|\\n/g, "\n").replace(/\\t/g, "  ");
  }

  $: rendered = readable(source);
</script>

<div class="model-markdown">
  <SvelteMarkdown source={rendered} sanitizeUrl={() => ""}>
    {#snippet link({ children })}<span class="rendered-link">{@render children?.()}</span>{/snippet}
    {#snippet image({ text })}<span class="rendered-image">[Image omitted: {text}]</span>{/snippet}
  </SvelteMarkdown>
</div>

<style>
  .model-markdown { color: inherit; font-size: inherit; line-height: inherit; }
  .model-markdown :global(p) { margin: 0 0 8px; }
  .model-markdown :global(p:last-child) { margin-bottom: 0; }
  .model-markdown :global(ul),.model-markdown :global(ol) { margin: 0 0 8px; padding-left: 18px; }
  .model-markdown :global(li) { margin: 2px 0; }
  .model-markdown :global(code) { border: 1px solid var(--border); border-radius: 4px; padding: 1px 4px; background: var(--surface-soft); font-family: "SFMono-Regular",Consolas,monospace; font-size: .92em; overflow-wrap: anywhere; }
  .model-markdown :global(pre) { overflow-x: auto; margin: 0 0 8px; border: 1px solid var(--border); border-radius: var(--radius-xs); padding: 8px 10px; background: var(--surface-soft); }
  .model-markdown :global(pre code) { border: 0; padding: 0; background: transparent; font-size: 12.5px; line-height: 1.55; overflow-wrap: normal; white-space: pre; }
  .model-markdown :global(strong) { font-weight: 750; }
  .model-markdown :global(h1),.model-markdown :global(h2),.model-markdown :global(h3),
  .model-markdown :global(h4),.model-markdown :global(h5),.model-markdown :global(h6) { margin: 10px 0 5px; font-size: 1.02em; font-weight: 780; }
  .model-markdown :global(blockquote) { margin: 0 0 8px; border-left: 2px solid var(--border); padding-left: 9px; color: var(--text-muted); }
  .model-markdown :global(table) { display: block; overflow-x: auto; border-collapse: collapse; font-size: 12.5px; }
  .model-markdown :global(th),.model-markdown :global(td) { border: 1px solid var(--border); padding: 4px 7px; text-align: left; }
  .model-markdown .rendered-link { color: var(--active-text); text-decoration: underline; }
  .model-markdown .rendered-image { color: var(--text-subtle); font-size: .92em; }
</style>
