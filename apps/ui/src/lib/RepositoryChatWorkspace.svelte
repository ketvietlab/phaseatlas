<script lang="ts">
  import { onMount, tick } from "svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import type { RendererComponent, Renderers } from "@humanspeak/svelte-markdown";
  import { markedMermaid, MermaidRenderer } from "@humanspeak/svelte-markdown/extensions";
  import type {
    PersistedRepositoryChatEvent,
    RepositoryChatAttachment,
    RepositoryChatMessage,
    RepositoryChatSession,
    RepositoryChatTurn,
    RunnerDescriptor,
  } from "@phaseatlas/contracts";

  export let checkoutId: string;
  export let repositoryName: string;
  export let runners: RunnerDescriptor[] = [];
  export let runnerId = "";
  export let modelId = "";
  export let onClose: () => void = () => undefined;
  export let onOpenProviderSettings: () => void = () => undefined;

  type Activity = {
    id: string;
    kind: "tool" | "reasoning" | "file";
    label: string;
    summary: string;
    output: string;
    status: "running" | "completed" | "failed";
    sequence: number;
  };

  const ACTIVE = new Set(["starting", "running"]);
  const TERMINAL_EVENTS = new Set(["chat.turn.completed", "chat.turn.failed", "chat.turn.cancelled", "chat.turn.interrupted"]);
  const markdownExtensions = [markedMermaid()];
  interface ChatMarkdownRenderers extends Renderers { mermaid: RendererComponent }
  const markdownRenderers: Partial<ChatMarkdownRenderers> = { mermaid: MermaidRenderer };

  let sessions: RepositoryChatSession[] = [];
  let selectedSessionId = "";
  let messagesBySession: Record<string, RepositoryChatMessage[]> = {};
  let turnsBySession: Record<string, RepositoryChatTurn[]> = {};
  let eventsByTurn: Record<string, PersistedRepositoryChatEvent[]> = {};
  let cursorByTurn: Record<string, number> = {};
  let loading = true;
  let creating = false;
  let sending = false;
  let composer = "";
  let attachmentDraft = "";
  let attachments: RepositoryChatAttachment[] = [];
  let renamingSessionId = "";
  let renameDraft = "";
  let errorMessage = "";
  let transcript: HTMLDivElement;
  let composerElement: HTMLTextAreaElement;
  let chatShellElement: HTMLElement;
  let clock = Date.now();
  let lastActivityAt: Record<string, number> = {};
  let loadGeneration = 0;

  $: selectedSession = sessions.find((session) => session.sessionId === selectedSessionId) ?? null;
  $: selectedMessages = selectedSessionId ? messagesBySession[selectedSessionId] ?? [] : [];
  $: selectedTurns = selectedSessionId ? turnsBySession[selectedSessionId] ?? [] : [];
  $: selectedRunner = runners.find((runner) => runner.id === runnerId);
  $: selectedModel = selectedRunner?.models.find((model) => model.id === modelId);
  $: providerReady = Boolean(selectedRunner?.available && selectedModel);
  $: activeTurn = [...selectedTurns].reverse().find((turn) => ACTIVE.has(turn.status)) ?? null;
  $: canSend = Boolean(selectedSession?.state === "open" && providerReady && composer.trim() && !sending && !activeTurn);

  onMount(() => {
    const timer = window.setInterval(() => clock = Date.now(), 1_000);
    const unsubscribe = window.phaseatlas?.events.subscribe((event) => {
      if (event.type !== "chat.turn.event" || event.checkoutId !== checkoutId) return;
      void receiveEvent(event.turnId, event.event);
    });
    void loadSessions();
    return () => {
      window.clearInterval(timer);
      unsubscribe?.();
    };
  });

  function selectionKey() {
    return `phaseatlas.chat.selected-session.v1.${checkoutId}`;
  }

  async function loadSessions(preferred = "") {
    if (!window.phaseatlas) return;
    const generation = ++loadGeneration;
    loading = true;
    errorMessage = "";
    try {
      const loaded = await window.phaseatlas.chat.listSessions(checkoutId);
      if (generation !== loadGeneration) return;
      sessions = loaded;
      const turnEntries = await Promise.all(loaded.map(async (session) => [
        session.sessionId,
        await window.phaseatlas!.chat.listTurns(checkoutId, session.sessionId),
      ] as const));
      if (generation !== loadGeneration) return;
      turnsBySession = Object.fromEntries(turnEntries);
      const remembered = preferred || window.localStorage.getItem(selectionKey()) || "";
      const next = loaded.find((session) => session.sessionId === remembered)
        ?? loaded.find((session) => session.state === "open")
        ?? loaded[0];
      selectedSessionId = next?.sessionId ?? "";
      if (next) await loadSession(next.sessionId, generation);
    } catch (error) {
      showError(error);
    } finally {
      if (generation === loadGeneration) loading = false;
    }
  }

  async function loadSession(sessionId: string, generation = loadGeneration) {
    if (!window.phaseatlas) return;
    selectedSessionId = sessionId;
    window.localStorage.setItem(selectionKey(), sessionId);
    const [messages, turns] = await Promise.all([
      window.phaseatlas.chat.listMessages(checkoutId, sessionId),
      window.phaseatlas.chat.listTurns(checkoutId, sessionId),
    ]);
    if (generation !== loadGeneration || selectedSessionId !== sessionId) return;
    messagesBySession = { ...messagesBySession, [sessionId]: messages };
    turnsBySession = { ...turnsBySession, [sessionId]: turns };
    await Promise.all(turns.map((turn) => replayTurn(turn.turnId)));
    await scrollToTail(false);
  }

  async function replayTurn(turnId: string) {
    if (!window.phaseatlas) return;
    let cursor = cursorByTurn[turnId] ?? 0;
    let hasMore = true;
    while (hasMore) {
      const page = await window.phaseatlas.chat.events(checkoutId, turnId, cursor, 200);
      mergeEvents(turnId, page.events);
      cursor = page.nextSequence;
      hasMore = page.hasMore;
    }
  }

  function mergeEvents(turnId: string, incoming: PersistedRepositoryChatEvent[]) {
    if (!incoming.length) return;
    const merged = new Map((eventsByTurn[turnId] ?? []).map((event) => [event.sequence, event]));
    incoming.forEach((event) => merged.set(event.sequence, event));
    const ordered = [...merged.values()].sort((left, right) => left.sequence - right.sequence);
    eventsByTurn = { ...eventsByTurn, [turnId]: ordered };
    cursorByTurn = { ...cursorByTurn, [turnId]: ordered.at(-1)?.sequence ?? 0 };
    lastActivityAt = { ...lastActivityAt, [turnId]: Date.now() };
  }

  async function receiveEvent(turnId: string, event: PersistedRepositoryChatEvent) {
    const cursor = cursorByTurn[turnId] ?? 0;
    if (event.sequence > cursor + 1) await replayTurn(turnId);
    mergeEvents(turnId, [event]);
    const turn = Object.values(turnsBySession).flat().find((candidate) => candidate.turnId === turnId);
    if (turn && TERMINAL_EVENTS.has(event.type)) {
      await refreshSession(turn.sessionId);
      sessions = await window.phaseatlas!.chat.listSessions(checkoutId);
    }
    if (turn?.sessionId === selectedSessionId) await scrollToTail(true);
  }

  async function refreshSession(sessionId: string) {
    if (!window.phaseatlas) return;
    const [messages, turns] = await Promise.all([
      window.phaseatlas.chat.listMessages(checkoutId, sessionId),
      window.phaseatlas.chat.listTurns(checkoutId, sessionId),
    ]);
    messagesBySession = { ...messagesBySession, [sessionId]: messages };
    turnsBySession = { ...turnsBySession, [sessionId]: turns };
  }

  async function createSession() {
    if (!window.phaseatlas || creating || !providerReady) return;
    creating = true;
    errorMessage = "";
    try {
      const session = await window.phaseatlas.chat.createSession(checkoutId, {
        runnerId,
        model: modelId,
        title: `New chat · ${new Date().toLocaleDateString([], { month: "short", day: "numeric" })}`,
      });
      sessions = [session, ...sessions];
      messagesBySession = { ...messagesBySession, [session.sessionId]: [] };
      turnsBySession = { ...turnsBySession, [session.sessionId]: [] };
      await selectSession(session.sessionId);
      await tick();
      composerElement?.focus();
    } catch (error) {
      showError(error);
    } finally {
      creating = false;
    }
  }

  async function selectSession(sessionId: string) {
    selectedSessionId = sessionId;
    await loadSession(sessionId);
  }

  async function sendMessage() {
    if (!window.phaseatlas || !selectedSession || !canSend) return;
    const text = composer.trim();
    const submittedAttachments = attachments;
    composer = "";
    attachments = [];
    sending = true;
    errorMessage = "";
    try {
      const { turnId } = await window.phaseatlas.chat.send(checkoutId, {
        sessionId: selectedSession.sessionId,
        text,
        ...(submittedAttachments.length ? { attachments: submittedAttachments } : {}),
      });
      await refreshSession(selectedSession.sessionId);
      await replayTurn(turnId);
      await scrollToTail(true);
    } catch (error) {
      composer = text;
      attachments = submittedAttachments;
      showError(error);
    } finally {
      sending = false;
    }
  }

  async function cancelTurn(turnId: string) {
    if (!window.phaseatlas) return;
    try {
      await window.phaseatlas.chat.cancel(checkoutId, turnId);
      if (selectedSessionId) await refreshSession(selectedSessionId);
    } catch (error) {
      showError(error);
    }
  }

  async function retryTurn(turnId: string) {
    if (!window.phaseatlas) return;
    try {
      const retried = await window.phaseatlas.chat.retry(checkoutId, { turnId });
      if (selectedSessionId) await refreshSession(selectedSessionId);
      await replayTurn(retried.turnId);
    } catch (error) {
      showError(error);
    }
  }

  async function closeSession(sessionId: string) {
    if (!window.phaseatlas) return;
    try {
      const closed = await window.phaseatlas.chat.closeSession(checkoutId, sessionId);
      sessions = sessions.map((session) => session.sessionId === sessionId ? closed : session);
    } catch (error) {
      showError(error);
    }
  }

  function beginRename(session: RepositoryChatSession) {
    renamingSessionId = session.sessionId;
    renameDraft = session.title;
  }

  async function commitRename() {
    if (!window.phaseatlas || !renamingSessionId || !renameDraft.trim()) return;
    try {
      const renamed = await window.phaseatlas.chat.renameSession(checkoutId, {
        sessionId: renamingSessionId,
        title: renameDraft.trim(),
      });
      sessions = sessions.map((session) => session.sessionId === renamed.sessionId ? renamed : session);
      renamingSessionId = "";
    } catch (error) {
      showError(error);
    }
  }

  function addAttachment() {
    const path = attachmentDraft.trim().replaceAll("\\", "/").replace(/^\.\//, "");
    if (!path || path.startsWith("/") || path.split("/").includes("..") || path === ".git" || path.startsWith(".git/")) {
      errorMessage = "Use a safe repository-relative file path.";
      return;
    }
    if (!attachments.some((attachment) => attachment.path === path)) attachments = [...attachments, { path }];
    attachmentDraft = "";
  }

  function userMessage(turn: RepositoryChatTurn) {
    return selectedMessages.find((message) => message.messageId === turn.userMessageId);
  }

  function assistantMessage(turn: RepositoryChatTurn) {
    return selectedMessages.find((message) => message.messageId === turn.assistantMessageId);
  }

  function streamedAnswer(turnId: string) {
    return (eventsByTurn[turnId] ?? [])
      .filter((event) => event.type === "chat.assistant.delta")
      .map((event) => typeof event.payload.text === "string" ? event.payload.text : "")
      .join("");
  }

  function activities(turnId: string): Activity[] {
    const events = eventsByTurn[turnId] ?? [];
    const items = new Map<string, Activity>();
    for (const event of events) {
      if (event.type === "chat.reasoning") {
        items.set(`reasoning-${event.sequence}`, {
          id: `reasoning-${event.sequence}`, kind: "reasoning", label: "Reasoning",
          summary: String(event.payload.summary ?? "Agent reasoning"), output: "", status: "completed", sequence: event.sequence,
        });
      }
      if (event.type === "chat.file.reference") {
        items.set(`file-${event.sequence}`, {
          id: `file-${event.sequence}`, kind: "file", label: "Repository file",
          summary: String(event.payload.path ?? "File reference"), output: "", status: "completed", sequence: event.sequence,
        });
      }
      if (event.type === "chat.tool.started") {
        const id = String(event.payload.toolCallId ?? `tool-${event.sequence}`);
        items.set(id, {
          id, kind: "tool", label: String(event.payload.tool ?? "Tool"),
          summary: String(event.payload.summary ?? "Inspecting repository"), output: "", status: "running", sequence: event.sequence,
        });
      }
      if (event.type === "chat.tool.output") {
        const id = String(event.payload.toolCallId ?? `tool-${event.sequence}`);
        const item = items.get(id);
        if (item) item.output += String(event.payload.text ?? "");
      }
      if (event.type === "chat.tool.completed") {
        const id = String(event.payload.toolCallId ?? `tool-${event.sequence}`);
        const item = items.get(id);
        if (item) item.status = event.payload.status === "failed" ? "failed" : "completed";
      }
    }
    return [...items.values()].sort((left, right) => left.sequence - right.sequence);
  }

  function terminalMessage(turn: RepositoryChatTurn) {
    const event = [...(eventsByTurn[turn.turnId] ?? [])].reverse().find((candidate) => TERMINAL_EVENTS.has(candidate.type));
    return typeof event?.payload.message === "string" ? event.payload.message : "";
  }

  function relativeTime(timestamp: string) {
    const value = new Date(timestamp).getTime();
    const seconds = Math.max(Math.round((clock - value) / 1_000), 0);
    if (seconds < 10) return "now";
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function silenceLabel(turnId: string) {
    const seconds = Math.max(Math.floor((clock - (lastActivityAt[turnId] ?? clock)) / 1_000), 0);
    return seconds < 4 ? "Streaming activity" : `Agent active · waiting ${seconds}s for the next event`;
  }

  function handleComposerKeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void sendMessage();
    }
  }

  function handleWindowKeydown(event: KeyboardEvent) {
    if (event.key === "Tab" && chatShellElement) {
      const focusable = [...chatShellElement.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
      )].filter((element) => !element.hidden && element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first && last && event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (first && last && !event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    if (event.key === "Escape" && renamingSessionId) renamingSessionId = "";
    else if (event.key === "Escape") onClose();
  }

  async function scrollToTail(smooth: boolean) {
    await tick();
    transcript?.scrollTo({ top: transcript.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      errorMessage = "Clipboard access is unavailable.";
    }
  }

  function showError(error: unknown) {
    errorMessage = error instanceof Error ? error.message : "The chat action could not be completed.";
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<div class="chat-layer" role="dialog" aria-modal="true" aria-labelledby="repository-chat-title">
  <section class="chat-shell" bind:this={chatShellElement}>
    <header class="chat-header">
      <div class="chat-mark" aria-hidden="true"><span></span><span></span><span></span></div>
      <div class="chat-title">
        <p>Repository intelligence</p>
        <h2 id="repository-chat-title">Agent chat <span>/ {repositoryName}</span></h2>
      </div>
      <button class="provider-chip" class:unavailable={!providerReady} type="button" title="Open provider settings" onclick={onOpenProviderSettings}>
        <span></span>
        <div><small>{selectedRunner?.name ?? "Provider unavailable"}</small><strong>{selectedModel?.displayName ?? "Select a discovered model"}</strong></div>
      </button>
      <span class="read-only-chip"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>Read only</span>
      <button class="close-chat" type="button" aria-label="Close agent chat" title="Close (Esc)" onclick={onClose}>×</button>
    </header>

    <div class="chat-grid">
      <aside class="session-rail" aria-label="Chat sessions">
        <div class="session-rail-header">
          <div><span>Conversations</span><strong>{sessions.length}</strong></div>
          <button type="button" aria-label="New conversation" title="New conversation" onclick={createSession} disabled={!providerReady || creating}>+</button>
        </div>
        <div class="session-list" role="tablist" aria-label="Repository conversations">
          {#if loading}
            {#each [1, 2, 3] as item}<div class="session-skeleton" aria-hidden="true"><span></span><i></i></div>{/each}
          {:else if sessions.length}
            {#each sessions as session}
              <div class:active={session.sessionId === selectedSessionId} class:closed={session.state === "closed"} class="session-item">
                {#if renamingSessionId === session.sessionId}
                  <form class="rename-form" onsubmit={(event) => { event.preventDefault(); void commitRename(); }}>
                    <input aria-label="Conversation name" maxlength="120" bind:value={renameDraft} />
                    <button type="submit">Save</button>
                  </form>
                {:else}
                  <button class="session-select" role="tab" aria-selected={session.sessionId === selectedSessionId} type="button" onclick={() => selectSession(session.sessionId)}>
                    <span class="session-state" data-state={(turnsBySession[session.sessionId] ?? []).some((turn) => ACTIVE.has(turn.status)) ? "running" : session.state}></span>
                    <span><strong>{session.title}</strong><small>{session.runnerId} · {relativeTime(session.updatedAt)}</small></span>
                  </button>
                  <div class="session-actions">
                    <button type="button" aria-label={`Rename ${session.title}`} title="Rename" onclick={() => beginRename(session)}>✎</button>
                    {#if session.state === "open"}<button type="button" aria-label={`Archive ${session.title}`} title="Archive" onclick={() => closeSession(session.sessionId)}>×</button>{/if}
                  </div>
                {/if}
              </div>
            {/each}
          {:else}
            <div class="session-empty"><strong>No conversations</strong><p>Start a repository-level chat without creating a task.</p></div>
          {/if}
        </div>
        <footer class="session-rail-footer"><span></span><p><strong>Local history</strong><small>Durable per checkout</small></p></footer>
      </aside>

      <main class="conversation">
        {#if selectedSession}
          <header class="conversation-header">
            <div><p>Current conversation</p><h3>{selectedSession.title}</h3></div>
            <div class="conversation-meta"><span>{selectedTurns.length} {selectedTurns.length === 1 ? "turn" : "turns"}</span><span>Updated {relativeTime(selectedSession.updatedAt)}</span></div>
          </header>

          <div class="transcript" bind:this={transcript} aria-live="polite" aria-label="Conversation transcript">
            {#if selectedTurns.length}
              <div class="transcript-column">
                {#each selectedTurns as turn (turn.turnId)}
                  {@const prompt = userMessage(turn)}
                  {@const answer = assistantMessage(turn)}
                  {@const streamed = streamedAnswer(turn.turnId)}
                  {@const turnActivities = activities(turn.turnId)}
                  <section class="turn" data-status={turn.status}>
                    {#if prompt}
                      <article class="message user-message">
                        <header><span>You</span><time datetime={prompt.createdAt}>{relativeTime(prompt.createdAt)}</time></header>
                        <p>{prompt.content}</p>
                        {#if prompt.attachments.length}<div class="message-attachments">{#each prompt.attachments as attachment}<code>{attachment.path}</code>{/each}</div>{/if}
                        {#if turn.parentTurnId}<small class="retry-note">Retried from an interrupted attempt</small>{/if}
                      </article>
                    {/if}

                    {#if turnActivities.length || ACTIVE.has(turn.status)}
                      <div class="agent-activity">
                        <header><span class:active={ACTIVE.has(turn.status)}></span><strong>{ACTIVE.has(turn.status) ? silenceLabel(turn.turnId) : `${turnActivities.length} agent ${turnActivities.length === 1 ? "activity" : "activities"}`}</strong><small>#{turn.turnId.slice(0, 6)}</small></header>
                        {#each turnActivities as activity}
                          <details class="activity-card" open={activity.status === "running"}>
                            <summary><span class="activity-icon" data-kind={activity.kind}>{activity.kind === "reasoning" ? "◇" : activity.kind === "file" ? "▤" : ">_"}</span><span><strong>{activity.label}</strong><small>{activity.summary}</small></span><i data-status={activity.status}></i></summary>
                            {#if activity.output}<pre>{activity.output}</pre>{/if}
                          </details>
                        {/each}
                        {#if ACTIVE.has(turn.status) && !turnActivities.length}<div class="quiet-pulse"><span></span><p><strong>Agent process is running</strong><small>Waiting for the provider's first structured event…</small></p></div>{/if}
                      </div>
                    {/if}

                    {#if answer || streamed}
                      <article class="message assistant-message">
                        <header><span><i></i>PhaseAtlas agent</span><div><time datetime={answer?.createdAt ?? turn.updatedAt}>{relativeTime(answer?.createdAt ?? turn.updatedAt)}</time><button type="button" aria-label="Copy assistant response" title="Copy response" onclick={() => copyText(answer?.content ?? streamed)}>Copy</button></div></header>
                        <div class="markdown-message" class:streaming={!answer && ACTIVE.has(turn.status)}>
                          <SvelteMarkdown source={answer?.content ?? streamed} extensions={markdownExtensions} renderers={markdownRenderers} sanitizeUrl={() => ""}>
                            {#snippet link({ children })}<span class="rendered-link">{@render children?.()}</span>{/snippet}
                            {#snippet image({ text })}<span class="rendered-image">[Image omitted: {text}]</span>{/snippet}
                          </SvelteMarkdown>
                        </div>
                      </article>
                    {/if}

                    {#if turn.status === "failed" || turn.status === "cancelled" || turn.status === "interrupted"}
                      <div class="turn-terminal" data-status={turn.status} role="status">
                        <span>{turn.status === "interrupted" ? "↻" : "!"}</span>
                        <p><strong>{turn.status === "interrupted" ? "Turn interrupted" : turn.status === "cancelled" ? "Turn cancelled" : "Agent could not complete this turn"}</strong><small>{terminalMessage(turn) || (turn.status === "interrupted" ? "The worker restarted before this turn reached a terminal result." : "The durable transcript remains available.")}</small></p>
                        {#if turn.status === "interrupted"}<button type="button" onclick={() => retryTurn(turn.turnId)}>Retry turn</button>{/if}
                      </div>
                    {/if}
                  </section>
                {/each}
              </div>
            {:else}
              <section class="conversation-empty">
                <div class="atlas-orbit" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
                <p>Repository conversation</p>
                <h3>Ask from where the work lives</h3>
                <p>Inspect architecture, trace behavior, compare approaches, or understand a file. Chat is read-only and independent from canonical tasks.</p>
                <div class="suggestions">
                  {#each ["Map the main runtime boundaries", "Explain the current repository state", "Find the code responsible for streaming"] as suggestion}
                    <button type="button" onclick={() => { composer = suggestion; composerElement?.focus(); }}>{suggestion}<span>↗</span></button>
                  {/each}
                </div>
              </section>
            {/if}
          </div>

          <footer class="composer-zone">
            {#if errorMessage}<div class="chat-error" role="alert"><span>!</span><p>{errorMessage}</p><button type="button" aria-label="Dismiss error" onclick={() => errorMessage = ""}>×</button></div>{/if}
            {#if attachments.length}<div class="attachment-list">{#each attachments as attachment}<span><code>{attachment.path}</code><button type="button" aria-label={`Remove ${attachment.path}`} onclick={() => attachments = attachments.filter((item) => item.path !== attachment.path)}>×</button></span>{/each}</div>{/if}
            <div class="composer-card" class:disabled={!providerReady || selectedSession.state === "closed"}>
              <textarea bind:this={composerElement} bind:value={composer} onkeydown={handleComposerKeydown} rows="2" maxlength="32000" placeholder={selectedSession.state === "closed" ? "This conversation is archived" : providerReady ? `Ask ${selectedRunner?.name} about ${repositoryName}…` : "Select an available provider and discovered model in repository settings"} disabled={!providerReady || selectedSession.state === "closed"}></textarea>
              <div class="composer-toolbar">
                <form class="attachment-entry" onsubmit={(event) => { event.preventDefault(); addAttachment(); }}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 12 5-5a3 3 0 0 1 4 4l-7 7a5 5 0 0 1-7-7l7-7"/></svg>
                  <input bind:value={attachmentDraft} aria-label="Repository-relative attachment path" placeholder="Attach repository path" />
                  {#if attachmentDraft}<button type="submit">Add</button>{/if}
                </form>
                <div class="composer-actions">
                  <span>{composer.length.toLocaleString()} / 32,000</span>
                  {#if activeTurn}<button class="cancel-button" type="button" onclick={() => cancelTurn(activeTurn!.turnId)}><i></i>Stop</button>{:else}<button class="send-button" type="button" aria-label="Send message" onclick={sendMessage} disabled={!canSend}><span>Send</span><kbd>↵</kbd></button>{/if}
                </div>
              </div>
            </div>
            <p class="composer-hint"><span><i></i>Read-only repository access</span><span>Enter to send · Shift Enter for a new line</span></p>
          </footer>
        {:else}
          <section class="no-session">
            <div class="atlas-orbit" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
            <p>Repository agent chat</p><h3>Start an independent conversation</h3>
            <p>Chat with a discovered provider without selecting a workspace or canonical task.</p>
            <button type="button" onclick={createSession} disabled={!providerReady || creating}>{creating ? "Creating conversation…" : "New conversation"}</button>
            {#if !providerReady}<small>Choose an available CLI and model first.</small><button class="settings-link" type="button" onclick={onOpenProviderSettings}>Open provider settings</button>{/if}
          </section>
        {/if}
      </main>
    </div>
  </section>
</div>

<style>
  .chat-layer { position: fixed; z-index: 96; inset: 0 0 0 var(--sidebar-width); padding: 10px; background: color-mix(in srgb,var(--canvas) 82%,transparent); backdrop-filter: blur(12px); animation: chat-in .2s cubic-bezier(.2,.76,.2,1); }
  .chat-shell { display: grid; width: 100%; height: 100%; grid-template-rows: 64px minmax(0,1fr); overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); color: var(--text); box-shadow: 0 24px 80px rgba(16,22,19,.18); }
  .chat-header { display: grid; min-width: 0; grid-template-columns: 40px minmax(220px,1fr) minmax(180px,auto) auto 36px; align-items: center; gap: 10px; border-bottom: 1px solid var(--border); padding: 0 12px 0 16px; background: color-mix(in srgb,var(--surface) 96%,var(--brand-50)); -webkit-app-region: drag; }
  .chat-header button,.chat-header .provider-chip,.chat-header .read-only-chip { -webkit-app-region: no-drag; }.chat-mark { position: relative; width: 32px; height: 32px; border: 1px solid var(--brand-200); border-radius: 10px; background: var(--active-surface); }.chat-mark span { position: absolute; width: 7px; height: 7px; border: 1px solid var(--brand-500); background: var(--surface); transform: rotate(45deg); }.chat-mark span:nth-child(1) { top: 5px; left: 12px; }.chat-mark span:nth-child(2) { bottom: 5px; left: 5px; }.chat-mark span:nth-child(3) { right: 5px; bottom: 5px; background: var(--brand-500); }
  .chat-title { min-width: 0; }.chat-title p,.conversation-header p { margin: 0 0 2px; color: var(--active-text); font-size: 11px; font-weight: 800; letter-spacing: .09em; text-transform: uppercase; }.chat-title h2 { overflow: hidden; margin: 0; font-size: 16px; letter-spacing: -.015em; text-overflow: ellipsis; white-space: nowrap; }.chat-title h2 span { color: var(--text-subtle); font-weight: 560; }
  .provider-chip { display: flex; min-width: 0; align-items: center; gap: 8px; border: 1px solid var(--border); border-radius: var(--radius); padding: 6px 9px; background: var(--surface); color: var(--text); text-align: left; }.provider-chip:hover { border-color: var(--brand-300); background: var(--active-surface); }.provider-chip > span { width: 7px; height: 7px; flex: 0 0 7px; border-radius: 50%; background: var(--success-500); box-shadow: 0 0 0 3px color-mix(in srgb,var(--success-500) 14%,transparent); }.provider-chip.unavailable > span { background: var(--warning-500); }.provider-chip div { min-width: 0; }.provider-chip small,.provider-chip strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.provider-chip small { color: var(--text-subtle); font-size: 10px; text-transform: uppercase; }.provider-chip strong { margin-top: 1px; font-size: 12px; }
  .read-only-chip { display: flex; align-items: center; gap: 5px; border: 1px solid var(--border); border-radius: var(--radius-full); padding: 5px 8px; color: var(--text-muted); font-size: 11px; font-weight: 750; text-transform: uppercase; }.read-only-chip svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.8; }.close-chat { display: grid; width: 34px; height: 34px; place-items: center; border: 0; border-radius: var(--radius); background: transparent; color: var(--text-muted); font-size: 24px; }.close-chat:hover { background: var(--surface-soft); color: var(--text); }
  .chat-grid { display: grid; min-height: 0; grid-template-columns: 252px minmax(0,1fr); }.session-rail { display: grid; min-height: 0; grid-template-rows: 52px minmax(0,1fr) 44px; border-right: 1px solid var(--border); background: var(--surface-soft); }.session-rail-header { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); padding: 0 10px 0 13px; }.session-rail-header > div { display: flex; align-items: center; gap: 7px; }.session-rail-header span { color: var(--text-muted); font-size: 12px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }.session-rail-header strong { display: grid; min-width: 20px; height: 18px; place-items: center; border-radius: var(--radius-full); background: var(--surface); color: var(--text-subtle); font-size: 11px; }.session-rail-header > button { display: grid; width: 29px; height: 29px; place-items: center; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--active-text); font-size: 18px; }.session-rail-header > button:hover { border-color: var(--brand-300); background: var(--active-surface); }.session-rail-header > button:disabled { opacity: .45; }
  .session-list { min-height: 0; overflow: auto; padding: 7px; }.session-item { position: relative; min-height: 60px; overflow: hidden; border: 1px solid transparent; border-radius: var(--radius); }.session-item + .session-item { margin-top: 3px; }.session-item:hover { background: var(--surface); }.session-item.active { border-color: var(--brand-200); background: var(--surface); box-shadow: 0 2px 8px rgba(25,31,28,.05); }.session-item.closed { opacity: .68; }.session-select { display: grid; width: 100%; min-height: 60px; grid-template-columns: 9px minmax(0,1fr); align-items: center; gap: 7px; border: 0; padding: 8px 45px 8px 8px; background: transparent; color: var(--text); text-align: left; }.session-select > span:last-child { min-width: 0; }.session-select strong,.session-select small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.session-select strong { font-size: 13px; }.session-select small { margin-top: 4px; color: var(--text-subtle); font: 10px/1.3 "SFMono-Regular",Consolas,monospace; }.session-state { width: 7px; height: 7px; border-radius: 50%; background: var(--ink-300); }.session-state[data-state="open"] { background: var(--success-500); }.session-state[data-state="running"] { background: var(--brand-500); animation: signal 1.2s ease infinite; }.session-actions { position: absolute; top: 50%; right: 6px; display: flex; opacity: 0; transform: translateY(-50%); }.session-item:hover .session-actions,.session-item.active .session-actions { opacity: 1; }.session-actions button { display: grid; width: 23px; height: 25px; place-items: center; border: 0; border-radius: var(--radius-xs); background: transparent; color: var(--text-subtle); font-size: 13px; }.session-actions button:hover { background: var(--surface-soft); color: var(--text); }.rename-form { display: grid; min-height: 60px; grid-template-columns: minmax(0,1fr) auto; align-items: center; gap: 5px; padding: 7px; }.rename-form input { min-width: 0; border: 1px solid var(--brand-400); border-radius: var(--radius-sm); padding: 7px; background: var(--surface); color: var(--text); font-size: 12px; }.rename-form button { border: 0; border-radius: var(--radius-sm); padding: 7px; background: var(--brand-600); color: white; font-size: 11px; }.session-empty { padding: 28px 16px; text-align: center; }.session-empty strong { font-size: 13px; }.session-empty p { margin: 5px 0; color: var(--text-subtle); font-size: 12px; line-height: 1.5; }.session-skeleton { display: grid; grid-template-columns: 8px 1fr; gap: 8px; margin: 8px; }.session-skeleton span { width: 7px; height: 7px; margin-top: 3px; border-radius: 50%; background: var(--border); }.session-skeleton i { height: 34px; border-radius: var(--radius-sm); background: linear-gradient(90deg,var(--surface),var(--border-soft),var(--surface)); background-size: 200% 100%; animation: shimmer 1.3s linear infinite; }.session-rail-footer { display: flex; align-items: center; gap: 8px; border-top: 1px solid var(--border); padding: 0 13px; }.session-rail-footer > span { width: 7px; height: 7px; border-radius: 2px; background: var(--brand-500); transform: rotate(45deg); }.session-rail-footer p { margin: 0; }.session-rail-footer strong,.session-rail-footer small { display: block; }.session-rail-footer strong { font-size: 11px; }.session-rail-footer small { margin-top: 1px; color: var(--text-subtle); font-size: 10px; }
  .conversation { display: grid; min-width: 0; min-height: 0; grid-template-rows: 52px minmax(0,1fr) auto; background: color-mix(in srgb,var(--surface) 97%,var(--canvas)); }.conversation-header { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 18px; border-bottom: 1px solid var(--border); padding: 0 18px; background: var(--surface); }.conversation-header > div:first-child { min-width: 0; }.conversation-header h3 { overflow: hidden; margin: 0; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }.conversation-meta { display: flex; gap: 6px; }.conversation-meta span { border: 1px solid var(--border); border-radius: var(--radius-full); padding: 4px 7px; color: var(--text-subtle); font-size: 11px; }
  .transcript { min-height: 0; overflow: auto; overscroll-behavior: contain; scroll-behavior: smooth; }.transcript-column { width: min(820px,calc(100% - 40px)); margin: 0 auto; padding: 30px 0 42px; }.turn + .turn { margin-top: 30px; border-top: 1px solid var(--border-soft); padding-top: 30px; }.message { position: relative; }.message header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }.message header span { font-size: 12px; font-weight: 800; letter-spacing: .035em; }.message time { color: var(--text-subtle); font-size: 11px; }.user-message { max-width: 76%; margin-left: auto; border: 1px solid var(--brand-200); border-radius: 14px 14px 4px 14px; padding: 12px 14px; background: var(--active-surface); }.user-message header span { color: var(--active-text); }.user-message p { margin: 0; color: var(--text); font-size: 13px; line-height: 1.58; white-space: pre-wrap; word-break: break-word; }.message-attachments { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 10px; }.message-attachments code { border: 1px solid var(--brand-200); border-radius: var(--radius-full); padding: 4px 7px; background: var(--surface); color: var(--active-text); font-size: 11px; }.retry-note { display: block; margin-top: 7px; color: var(--text-subtle); font-size: 11px; }.assistant-message { margin-top: 18px; }.assistant-message > header { border-bottom: 1px solid var(--border-soft); padding-bottom: 8px; }.assistant-message > header span { display: flex; align-items: center; gap: 7px; }.assistant-message > header span i { width: 8px; height: 8px; border-radius: 2px; background: var(--brand-500); transform: rotate(45deg); }.assistant-message > header div { display: flex; align-items: center; gap: 8px; }.assistant-message > header button { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 3px 6px; background: var(--surface); color: var(--text-subtle); font-size: 10px; }.markdown-message { color: var(--text-muted); font-size: 13px; line-height: 1.72; }.markdown-message.streaming::after { display: inline-block; width: 6px; height: 13px; margin-left: 3px; background: var(--brand-500); content: ""; vertical-align: -2px; animation: blink .8s steps(2,end) infinite; }.markdown-message :global(p) { margin: 0 0 11px; }.markdown-message :global(h1),.markdown-message :global(h2),.markdown-message :global(h3) { margin: 18px 0 8px; color: var(--text); line-height: 1.35; }.markdown-message :global(h1) { font-size: 20px; }.markdown-message :global(h2) { font-size: 17px; }.markdown-message :global(h3) { font-size: 14px; }.markdown-message :global(ul),.markdown-message :global(ol) { padding-left: 21px; }.markdown-message :global(code) { border: 1px solid var(--border); border-radius: var(--radius-xs); padding: 1px 4px; background: var(--surface-soft); color: var(--text); font: 13px/1.55 "SFMono-Regular",Consolas,monospace; }.markdown-message :global(pre) { overflow: auto; border: 1px solid #303a35; border-radius: var(--radius); padding: 12px; background: #131a17; color: #c8d5cd; }.markdown-message :global(pre code) { border: 0; padding: 0; background: transparent; color: inherit; }.markdown-message :global(a) { color: var(--active-text); pointer-events: none; text-decoration: underline; }.markdown-message :global(img) { display: none; }.markdown-message :global(table) { width: 100%; border-collapse: collapse; }.markdown-message :global(th),.markdown-message :global(td) { border: 1px solid var(--border); padding: 6px 8px; text-align: left; }.markdown-message :global(.mermaid) { overflow: auto; }
  .agent-activity { overflow: hidden; margin: 14px 0 0 8%; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }.agent-activity > header { display: flex; align-items: center; gap: 8px; min-height: 34px; border-bottom: 1px solid var(--border-soft); padding: 0 10px; background: var(--surface-soft); }.agent-activity > header > span { width: 7px; height: 7px; border-radius: 50%; background: var(--success-500); }.agent-activity > header > span.active { animation: signal 1.2s ease infinite; }.agent-activity > header strong { flex: 1; color: var(--text-muted); font-size: 11px; }.agent-activity > header small { color: var(--text-subtle); font: 10px/1 "SFMono-Regular",Consolas,monospace; }.activity-card + .activity-card { border-top: 1px solid var(--border-soft); }.activity-card summary { display: grid; min-height: 42px; grid-template-columns: 27px minmax(0,1fr) 8px; align-items: center; gap: 8px; padding: 5px 10px; cursor: pointer; list-style: none; }.activity-card summary::-webkit-details-marker { display: none; }.activity-icon { display: grid; width: 25px; height: 25px; place-items: center; border-radius: var(--radius-xs); background: var(--active-surface); color: var(--active-text); font: 10px/1 "SFMono-Regular",Consolas,monospace; }.activity-icon[data-kind="reasoning"] { background: var(--warning-surface); color: var(--warning-text); }.activity-card summary > span:nth-child(2) { min-width: 0; }.activity-card strong,.activity-card small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.activity-card strong { font-size: 11px; text-transform: capitalize; }.activity-card small { margin-top: 2px; color: var(--text-subtle); font-size: 10px; }.activity-card summary i { width: 7px; height: 7px; border-radius: 50%; background: var(--success-500); }.activity-card summary i[data-status="running"] { background: var(--brand-500); animation: signal 1.2s ease infinite; }.activity-card summary i[data-status="failed"] { background: #c44242; }.activity-card pre { max-height: 180px; overflow: auto; margin: 0; border-top: 1px solid #2b3731; padding: 10px; background: #121916; color: #aebbb3; font: 12px/1.55 "SFMono-Regular",Consolas,monospace; white-space: pre-wrap; word-break: break-word; }.quiet-pulse { display: flex; align-items: center; gap: 10px; padding: 12px; }.quiet-pulse > span { width: 22px; height: 22px; border: 2px solid var(--border); border-top-color: var(--brand-500); border-radius: 50%; animation: spin .9s linear infinite; }.quiet-pulse p { margin: 0; }.quiet-pulse strong,.quiet-pulse small { display: block; }.quiet-pulse strong { font-size: 11px; }.quiet-pulse small { margin-top: 2px; color: var(--text-subtle); font-size: 10px; }
  .turn-terminal { display: grid; grid-template-columns: 28px minmax(0,1fr) auto; align-items: center; gap: 9px; margin-top: 13px; border: 1px solid color-mix(in srgb,#c44242 35%,var(--border)); border-radius: var(--radius); padding: 9px; background: color-mix(in srgb,#c44242 7%,var(--surface)); }.turn-terminal[data-status="interrupted"] { border-color: color-mix(in srgb,var(--warning-500) 45%,var(--border)); background: var(--warning-surface); }.turn-terminal > span { display: grid; width: 26px; height: 26px; place-items: center; border-radius: var(--radius-sm); background: #c44242; color: white; font-weight: 850; }.turn-terminal[data-status="interrupted"] > span { background: var(--warning-500); }.turn-terminal p { margin: 0; }.turn-terminal strong,.turn-terminal small { display: block; }.turn-terminal strong { font-size: 12px; }.turn-terminal small { margin-top: 2px; color: var(--text-muted); font-size: 11px; }.turn-terminal button { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px 8px; background: var(--surface); color: var(--text); font-size: 11px; font-weight: 750; }
  .conversation-empty,.no-session { display: grid; justify-items: center; align-content: center; text-align: center; }.conversation-empty { min-height: 100%; padding: 28px; }.conversation-empty > p:first-of-type,.no-session > p:first-of-type { margin: 16px 0 3px; color: var(--active-text); font-size: 11px; font-weight: 800; letter-spacing: .09em; text-transform: uppercase; }.conversation-empty h3,.no-session h3 { margin: 0; font-size: 21px; letter-spacing: -.02em; }.conversation-empty > p:nth-of-type(2),.no-session > p:nth-of-type(2) { max-width: 490px; margin: 8px 0 18px; color: var(--text-muted); font-size: 13px; line-height: 1.6; }.atlas-orbit { position: relative; width: 54px; height: 54px; border: 1px solid var(--brand-200); border-radius: 50%; background: var(--active-surface); }.atlas-orbit::before,.atlas-orbit::after { position: absolute; inset: 13px; border: 1px solid var(--brand-300); border-radius: 50%; content: ""; }.atlas-orbit::after { inset: 25px; border: 0; background: var(--brand-600); }.atlas-orbit span { position: absolute; width: 6px; height: 6px; border-radius: 2px; background: var(--brand-500); transform: rotate(45deg); }.atlas-orbit span:nth-child(1) { top: 5px; left: 24px; }.atlas-orbit span:nth-child(2) { top: 24px; right: 5px; }.atlas-orbit span:nth-child(3) { bottom: 5px; left: 24px; }.atlas-orbit span:nth-child(4) { top: 24px; left: 5px; }.suggestions { display: grid; width: min(520px,100%); gap: 6px; }.suggestions button { display: flex; min-height: 38px; align-items: center; justify-content: space-between; border: 1px solid var(--border); border-radius: var(--radius); padding: 0 11px; background: var(--surface); color: var(--text-muted); font-size: 12px; text-align: left; }.suggestions button:hover { border-color: var(--brand-200); color: var(--active-text); transform: translateX(2px); }.suggestions span { color: var(--brand-500); }
  .composer-zone { position: relative; border-top: 1px solid var(--border); padding: 10px 18px 8px; background: color-mix(in srgb,var(--surface) 94%,transparent); backdrop-filter: blur(12px); }.composer-card { width: min(850px,100%); margin: 0 auto; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: 0 4px 18px rgba(25,31,28,.07); }.composer-card:focus-within { border-color: var(--brand-400); box-shadow: 0 0 0 3px color-mix(in srgb,var(--brand-400) 14%,transparent); }.composer-card.disabled { opacity: .65; }.composer-card textarea { display: block; width: 100%; min-height: 54px; max-height: 180px; resize: vertical; border: 0; padding: 12px 14px 7px; outline: 0; background: transparent; color: var(--text); font: 12px/1.55 Inter,ui-sans-serif,system-ui,sans-serif; }.composer-card textarea::placeholder { color: var(--text-subtle); }.composer-toolbar { display: flex; min-height: 38px; align-items: center; justify-content: space-between; gap: 10px; border-top: 1px solid var(--border-soft); padding: 4px 5px 4px 10px; }.attachment-entry { display: flex; min-width: 0; flex: 1; align-items: center; gap: 5px; }.attachment-entry svg { width: 14px; height: 14px; flex: 0 0 14px; fill: none; stroke: var(--text-subtle); stroke-linecap: round; stroke-width: 1.7; }.attachment-entry input { width: min(230px,100%); border: 0; outline: 0; background: transparent; color: var(--text-muted); font: 11px/1.4 "SFMono-Regular",Consolas,monospace; }.attachment-entry button { border: 1px solid var(--border); border-radius: var(--radius-xs); padding: 3px 6px; background: var(--surface-soft); color: var(--text); font-size: 10px; }.composer-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; }.composer-actions > span { color: var(--text-subtle); font-size: 10px; }.send-button,.cancel-button { display: flex; min-height: 29px; align-items: center; gap: 8px; border: 0; border-radius: var(--radius-sm); padding: 0 9px; background: var(--brand-600); color: white; font-size: 11px; font-weight: 800; }.send-button kbd { border-left: 1px solid rgba(255,255,255,.25); padding-left: 7px; font: inherit; }.send-button:disabled { opacity: .38; }.cancel-button { background: #b94040; }.cancel-button i { width: 7px; height: 7px; background: white; }.composer-hint { display: flex; width: min(850px,100%); justify-content: space-between; margin: 5px auto 0; color: var(--text-subtle); font-size: 10px; }.composer-hint span { display: flex; align-items: center; gap: 5px; }.composer-hint i { width: 5px; height: 5px; border-radius: 50%; background: var(--success-500); }.attachment-list { display: flex; width: min(850px,100%); flex-wrap: wrap; gap: 5px; margin: 0 auto 6px; }.attachment-list > span { display: flex; align-items: center; gap: 5px; border: 1px solid var(--brand-200); border-radius: var(--radius-full); padding: 4px 5px 4px 8px; background: var(--active-surface); }.attachment-list code { color: var(--active-text); font-size: 10px; }.attachment-list button { display: grid; width: 16px; height: 16px; place-items: center; border: 0; border-radius: 50%; background: var(--surface); color: var(--text-muted); font-size: 13px; }.chat-error { display: grid; width: min(850px,100%); grid-template-columns: 20px minmax(0,1fr) 20px; align-items: center; gap: 7px; margin: 0 auto 7px; border: 1px solid color-mix(in srgb,#c44242 40%,var(--border)); border-radius: var(--radius); padding: 6px; background: color-mix(in srgb,#c44242 7%,var(--surface)); }.chat-error > span { display: grid; width: 20px; height: 20px; place-items: center; border-radius: var(--radius-xs); background: #c44242; color: white; font-size: 11px; font-weight: 850; }.chat-error p { overflow: hidden; margin: 0; color: var(--text-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.chat-error button { border: 0; background: transparent; color: var(--text-muted); font-size: 16px; }
  .no-session { min-height: 100%; grid-row: 1 / -1; padding: 30px; }.no-session > button { min-height: 38px; border: 1px solid var(--brand-600); border-radius: var(--radius); padding: 0 13px; background: var(--brand-600); color: white; font-size: 12px; font-weight: 800; }.no-session > button:disabled { opacity: .45; }.no-session > small { margin-top: 8px; color: var(--warning-text); font-size: 11px; }.no-session > .settings-link { min-height: 30px; margin-top: 7px; border-color: var(--border); background: var(--surface); color: var(--active-text); }
  .session-actions:focus-within { opacity: 1; }
  .markdown-message :global(.rendered-link) { color: var(--active-text); text-decoration: underline; text-underline-offset: 2px; }.markdown-message :global(.rendered-image) { color: var(--text-subtle); font-style: italic; }
  @keyframes chat-in { from { opacity: .4; transform: translateY(7px) scale(.997); } } @keyframes signal { 50% { opacity: .3; box-shadow: 0 0 0 5px color-mix(in srgb,var(--brand-500) 12%,transparent); } } @keyframes spin { to { transform: rotate(360deg); } } @keyframes blink { 50% { opacity: .15; } } @keyframes shimmer { to { background-position: -200% 0; } }
  @media (max-width: 980px) { .chat-grid { grid-template-columns: 210px minmax(0,1fr); }.transcript-column { width: calc(100% - 28px); }.provider-chip { max-width: 190px; }.read-only-chip { display: none; }.chat-header { grid-template-columns: 40px minmax(170px,1fr) minmax(150px,auto) 36px; } }
  @media (max-width: 767.98px) { .chat-layer { inset: 0; padding: 0; }.chat-shell { border: 0; border-radius: 0; }.chat-grid { grid-template-columns: 160px minmax(0,1fr); }.session-select { padding-right: 8px; }.session-actions { display: none; }.provider-chip { display: none; }.chat-header { grid-template-columns: 40px minmax(0,1fr) 36px; }.conversation-meta { display: none; }.user-message { max-width: 90%; }.composer-zone { padding-inline: 10px; } }
  @media (max-width: 560px) { .chat-grid { display: block; }.session-rail { display: none; }.conversation { height: 100%; }.chat-title h2 span { display: none; }.transcript-column { width: calc(100% - 20px); padding-top: 18px; }.composer-hint span:last-child,.composer-actions > span { display: none; }.agent-activity { margin-left: 0; } }
  @media (prefers-reduced-motion: reduce) { .chat-layer,.session-state,.agent-activity > header > span,.quiet-pulse > span,.markdown-message.streaming::after { animation: none; } }
</style>
