<script lang="ts">
  import { onMount, tick } from "svelte";
  import type {
    AgentRunSummary,
    PersistedRunEvent,
    RepositoryChatMessage,
    RepositoryChatSession,
    RepositoryChatTurn,
  } from "@phaseatlas/contracts";

  export let checkoutId: string;
  export let taskKey: string;
  export let runnerId = "";
  export let modelId = "";
  export let reasoningEffort = "";
  export let runs: AgentRunSummary[] = [];
  export let runEvents: Record<string, PersistedRunEvent[]> = {};
  export let providerReady = false;

  type StageEntry = {
    kind: "stage";
    id: string;
    at: string;
    run: AgentRunSummary;
    narration: string;
    commands: number;
    failure: string;
  };
  type MessageEntry = { kind: "message"; id: string; at: string; message: RepositoryChatMessage };
  type Entry = StageEntry | MessageEntry;

  const ACTIVE_TURN = new Set(["starting", "running"]);
  const ACTION_LABEL: Record<string, string> = {
    analyze: "Analyze",
    plan: "Plan",
    implement: "Implement",
    review: "Review",
  };

  let session: RepositoryChatSession | null = null;
  let messages: RepositoryChatMessage[] = [];
  let turns: RepositoryChatTurn[] = [];
  let composer = "";
  let sending = false;
  let errorMessage = "";
  let transcriptElement: HTMLDivElement | undefined;

  $: activeRun = runs.find((run) => run.status === "starting" || run.status === "running") ?? null;
  $: activeTurn = [...turns].reverse().find((turn) => ACTIVE_TURN.has(turn.status)) ?? null;
  // A stage in flight owns the thread: its narration is still arriving and its
  // result is what the next question would be asked about.
  $: composerBlocked = Boolean(activeRun || activeTurn || sending || !providerReady || !session);
  $: canSend = Boolean(composer.trim()) && !composerBlocked;

  $: stageEntries = runs.map((run) => {
    const events = runEvents[run.runId] ?? [];
    const narration = events
      .filter((event) => event.type === "agent.delta" && typeof event.payload.text === "string")
      .map((event) => String(event.payload.text))
      .join("");
    const failureEvent = events.find((event) => event.type === "run.failed");
    return {
      kind: "stage" as const,
      id: `stage-${run.runId}`,
      at: run.createdAt,
      run,
      narration: narration.trim(),
      commands: events.filter((event) => event.type === "command.completed").length,
      failure: typeof failureEvent?.payload.message === "string" ? failureEvent.payload.message : "",
    };
  });
  $: messageEntries = messages.map((message) => ({
    kind: "message" as const,
    id: `message-${message.messageId}`,
    at: message.createdAt,
    message,
  }));
  // One thread: stages and questions interleave by when they happened.
  $: entries = [...stageEntries, ...messageEntries]
    .sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id)) as Entry[];

  onMount(() => {
    const unsubscribe = window.phaseatlas?.events.subscribe((event) => {
      if (event.type !== "chat.turn.event" || event.checkoutId !== checkoutId) return;
      if (!session) return;
      void reload();
    });
    void ensureSession();
    return () => unsubscribe?.();
  });

  $: if (taskKey) void ensureSession();

  async function ensureSession() {
    if (!window.phaseatlas || !taskKey || !runnerId || !modelId) return;
    if (session?.taskKey === taskKey) return;
    try {
      session = await window.phaseatlas.chat.createSession(checkoutId, {
        runnerId,
        model: modelId,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        taskKey,
        title: `Task ${taskKey}`,
      });
      await reload();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "The task conversation could not be opened.";
    }
  }

  async function reload() {
    if (!window.phaseatlas || !session) return;
    const [nextMessages, nextTurns] = await Promise.all([
      window.phaseatlas.chat.listMessages(checkoutId, session.sessionId),
      window.phaseatlas.chat.listTurns(checkoutId, session.sessionId),
    ]);
    messages = nextMessages;
    turns = nextTurns;
    await tick();
    if (transcriptElement) transcriptElement.scrollTop = transcriptElement.scrollHeight;
  }

  async function send() {
    if (!window.phaseatlas || !session || !canSend) return;
    sending = true;
    errorMessage = "";
    const text = composer;
    composer = "";
    try {
      await window.phaseatlas.chat.send(checkoutId, { sessionId: session.sessionId, text });
      await reload();
    } catch (error) {
      composer = text;
      errorMessage = error instanceof Error ? error.message : "The message could not be sent.";
    } finally {
      sending = false;
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void send();
  }

  function stageStatusLabel(run: AgentRunSummary): string {
    if (run.status === "completed") return "Completed";
    if (run.status === "failed") return "Failed";
    if (run.status === "cancelled") return "Cancelled";
    if (run.status === "interrupted") return "Interrupted";
    return "Running";
  }

  function relativeTime(value: string): string {
    return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
</script>

<section class="task-conversation" aria-label="Task conversation">
  <div class="conversation-transcript" bind:this={transcriptElement}>
    {#if !entries.length}
      <p class="conversation-empty">
        No stage has run yet. Start one above, or ask a question about this task below.
      </p>
    {/if}

    {#each entries as entry (entry.id)}
      {#if entry.kind === "stage"}
        <article class="stage-entry" data-status={entry.run.status}>
          <header>
            <strong>{ACTION_LABEL[entry.run.action] ?? entry.run.action}</strong>
            <span class="stage-status">{stageStatusLabel(entry.run)}</span>
            <span class="stage-provider">{entry.run.runnerId}{entry.run.model ? ` · ${entry.run.model}` : ""}</span>
            <time>{relativeTime(entry.run.createdAt)}</time>
          </header>
          {#if entry.narration}
            <p class="stage-narration">{entry.narration}</p>
          {/if}
          {#if entry.commands}
            <p class="stage-activity">{entry.commands} repository {entry.commands === 1 ? "command" : "commands"}</p>
          {/if}
          {#if entry.failure}
            <p class="stage-failure">{entry.failure}</p>
          {/if}
        </article>
      {:else}
        <article class="message-entry" data-role={entry.message.role}>
          <header><strong>{entry.message.role === "user" ? "You" : "Agent"}</strong><time>{relativeTime(entry.message.createdAt)}</time></header>
          <p>{entry.message.content}</p>
        </article>
      {/if}
    {/each}

    {#if activeRun}
      <p class="conversation-status" role="status">
        {ACTION_LABEL[activeRun.action] ?? activeRun.action} is running — the composer reopens when it finishes.
      </p>
    {:else if activeTurn}
      <p class="conversation-status" role="status">Waiting for the agent…</p>
    {/if}
  </div>

  {#if errorMessage}
    <p class="conversation-error" role="alert">{errorMessage}</p>
  {/if}

  <div class="conversation-composer" class:disabled={composerBlocked}>
    <textarea
      bind:value={composer}
      onkeydown={handleKeydown}
      rows="2"
      maxlength="32000"
      aria-label="Ask about this task"
      placeholder={providerReady
        ? activeRun
          ? "A stage is running…"
          : "Ask about this task — the agent sees the contract and every completed stage"
        : "Choose an available CLI and model first"}
      disabled={composerBlocked}
    ></textarea>
    <div class="conversation-composer-actions">
      <small>Read-only · shares this task's thread</small>
      <button type="button" onclick={send} disabled={!canSend}>Send<kbd>↵</kbd></button>
    </div>
  </div>
</section>

<style>
  .task-conversation { display: flex; min-height: 0; flex: 1; flex-direction: column; gap: 8px; }
  .conversation-transcript { display: flex; min-height: 0; flex: 1; flex-direction: column; gap: 8px; overflow-y: auto; padding-right: 4px; }
  .conversation-empty { margin: 18px 0; color: var(--text-subtle); font-size: 12px; text-align: center; }

  .stage-entry { border: 1px solid var(--border); border-left-width: 3px; border-radius: var(--radius); padding: 8px 10px; background: var(--surface); }
  .stage-entry[data-status="completed"] { border-left-color: var(--success-500); }
  .stage-entry[data-status="failed"] { border-left-color: #c44242; }
  .stage-entry[data-status="running"],.stage-entry[data-status="starting"] { border-left-color: var(--brand-500); }
  .stage-entry header { display: flex; align-items: baseline; gap: 8px; }
  .stage-entry header strong { font-size: 12px; font-weight: 780; }
  .stage-status { color: var(--text-muted); font-size: 10px; font-weight: 700; }
  .stage-provider { overflow: hidden; color: var(--text-subtle); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
  .stage-entry time,.message-entry time { margin-left: auto; color: var(--text-subtle); font-size: 10px; }
  .stage-narration { margin: 6px 0 0; color: var(--text); font-size: 12px; line-height: 1.55; white-space: pre-wrap; }
  .stage-activity { margin: 5px 0 0; color: var(--text-subtle); font-size: 10px; }
  .stage-failure { margin: 6px 0 0; border-radius: var(--radius-xs); padding: 5px 7px; background: color-mix(in srgb,#c44242 9%,var(--surface)); color: var(--text-muted); font-size: 11px; }

  .message-entry { border-radius: var(--radius); padding: 7px 10px; background: var(--surface-soft); }
  .message-entry[data-role="user"] { align-self: flex-end; max-width: 82%; background: var(--active-surface); color: var(--active-text); }
  .message-entry header { display: flex; align-items: baseline; gap: 8px; }
  .message-entry header strong { font-size: 10px; font-weight: 750; text-transform: uppercase; letter-spacing: .05em; }
  .message-entry p { margin: 4px 0 0; font-size: 12px; line-height: 1.55; white-space: pre-wrap; }

  .conversation-status { margin: 2px 0 0; color: var(--text-subtle); font-size: 11px; }
  .conversation-error { margin: 0; border-radius: var(--radius-xs); padding: 6px 8px; background: color-mix(in srgb,#c44242 8%,var(--surface)); color: var(--text-muted); font-size: 11px; }

  .conversation-composer { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
  .conversation-composer.disabled { opacity: .72; }
  .conversation-composer textarea { display: block; width: 100%; min-height: 46px; border: 0; border-radius: var(--radius) var(--radius) 0 0; padding: 8px 10px; background: transparent; color: var(--text); font-family: inherit; font-size: 12px; line-height: 1.5; outline: none; resize: vertical; }
  .conversation-composer-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; border-top: 1px solid var(--border-soft); padding: 5px 7px; }
  .conversation-composer-actions small { color: var(--text-subtle); font-size: 10px; }
  .conversation-composer-actions button { display: flex; align-items: center; gap: 7px; border: 0; border-radius: var(--radius-sm); padding: 5px 9px; background: var(--brand-600); color: #fff; font-size: 11px; font-weight: 800; }
  .conversation-composer-actions button:disabled { opacity: .4; }
  .conversation-composer-actions kbd { border-left: 1px solid rgba(255,255,255,.28); padding-left: 6px; font: inherit; }
</style>
