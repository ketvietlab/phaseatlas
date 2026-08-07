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
        <article class="turn" data-role="assistant">
          <div class="turn-gutter" aria-hidden="true"><span class="stage-dot" data-status={entry.run.status}></span></div>
          <div class="turn-body">
            <p class="turn-byline">
              <strong>{ACTION_LABEL[entry.run.action] ?? entry.run.action}</strong>
              <span>{stageStatusLabel(entry.run)}</span>
              <span>{entry.run.runnerId}{entry.run.model ? ` · ${entry.run.model}` : ""}</span>
              <time>{relativeTime(entry.run.createdAt)}</time>
            </p>
            {#if entry.narration}<p class="turn-text">{entry.narration}</p>{/if}
            {#if entry.commands}
              <p class="turn-activity">Ran {entry.commands} repository {entry.commands === 1 ? "command" : "commands"}</p>
            {/if}
            {#if entry.failure}<p class="turn-failure">{entry.failure}</p>{/if}
          </div>
        </article>
      {:else}
        <article class="turn" data-role={entry.message.role}>
          <div class="turn-gutter" aria-hidden="true">{entry.message.role === "user" ? "You" : ""}</div>
          <div class="turn-body">
            <p class="turn-byline"><strong>{entry.message.role === "user" ? "You" : "Agent"}</strong><time>{relativeTime(entry.message.createdAt)}</time></p>
            <p class="turn-text">{entry.message.content}</p>
          </div>
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

  /* One column of turns, byline above text — the shape Claude Code, Cursor and
     Codex all use, so nothing competes with the message itself for attention. */
  .turn { display: grid; grid-template-columns: 34px minmax(0,1fr); gap: 10px; padding: 2px 0; }
  .turn-gutter { display: flex; height: 20px; align-items: center; justify-content: flex-end; color: var(--text-subtle); font-size: 9px; font-weight: 750; letter-spacing: .04em; text-transform: uppercase; }
  .stage-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-subtle); }
  .stage-dot[data-status="completed"] { background: var(--success-500); }
  .stage-dot[data-status="failed"] { background: #c44242; }
  .stage-dot[data-status="running"],.stage-dot[data-status="starting"] { background: var(--brand-500); }
  .turn-body { min-width: 0; }
  .turn-byline { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin: 0 0 3px; color: var(--text-subtle); font-size: 10px; }
  .turn-byline strong { color: var(--text); font-size: 11px; font-weight: 780; }
  .turn-byline time { margin-left: auto; }
  .turn-text { margin: 0; color: var(--text); font-size: 12.5px; line-height: 1.62; white-space: pre-wrap; overflow-wrap: anywhere; }
  .turn[data-role="user"] .turn-text { border-left: 2px solid var(--brand-300); padding-left: 9px; color: var(--text-muted); }
  .turn-activity { margin: 5px 0 0; color: var(--text-subtle); font-size: 10.5px; }
  .turn-failure { margin: 6px 0 0; border-radius: var(--radius-xs); padding: 6px 8px; background: color-mix(in srgb,#c44242 8%,var(--surface)); color: var(--text-muted); font-size: 11px; }

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
