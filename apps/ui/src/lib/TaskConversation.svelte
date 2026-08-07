<script lang="ts">
  import { onMount, tick } from "svelte";
  import type {
    AgentRunSummary,
    ChatEditConfirmation,
    ChatEditResult,
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
  let chatMode: "ask" | "edit" = "ask";
  let editAccessMode: "ask_for_approval" | "full_access" = "ask_for_approval";
  let preparedEdit: ChatEditConfirmation | null = null;
  let edits: ChatEditResult[] = [];
  let editBusy = false;
  let sending = false;
  let errorMessage = "";
  let transcriptElement: HTMLDivElement | undefined;

  $: activeRun = runs.find((run) => run.status === "starting" || run.status === "running") ?? null;
  $: activeTurn = [...turns].reverse().find((turn) => ACTIVE_TURN.has(turn.status)) ?? null;
  // A stage in flight owns the thread: its narration is still arriving and its
  // result is what the next question would be asked about.
  $: activeEdit = edits.find((edit) => edit.status === "running") ?? null;
  $: reviewEdit = edits.find((edit) => edit.status === "completed" && edit.disposition === "pending_review") ?? null;
  $: composerBlocked = Boolean(activeRun || activeTurn || activeEdit || editBusy || sending || !providerReady || !session);
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
      await refreshEdits();
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

  async function refreshEdits() {
    if (!window.phaseatlas || !session) return;
    edits = await window.phaseatlas.chat.listEdits(checkoutId, session.sessionId);
  }

  // Edit mode is the existing confirmed, isolated, reviewed write path — the
  // conversation gets it rather than a second way to change the repository.
  async function prepareEdit() {
    if (!window.phaseatlas || !session || !composer.trim() || editBusy) return;
    editBusy = true;
    errorMessage = "";
    try {
      const confirmation = await window.phaseatlas.chat.prepareEdit(checkoutId, {
        sessionId: session.sessionId,
        prompt: composer.trim(),
        accessMode: editAccessMode,
      });
      if (editAccessMode === "full_access") await startPreparedEdit(confirmation);
      else preparedEdit = confirmation;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "The edit could not be prepared.";
    } finally {
      editBusy = false;
    }
  }

  async function startPreparedEdit(confirmation: ChatEditConfirmation) {
    if (!window.phaseatlas) return;
    await window.phaseatlas.chat.startEdit(checkoutId, {
      editId: confirmation.editId,
      confirmationDigest: confirmation.confirmationDigest,
    });
    composer = "";
    preparedEdit = null;
    await refreshEdits();
  }

  async function resolveEdit(editId: string, action: "accept" | "discard") {
    if (!window.phaseatlas || editBusy) return;
    editBusy = true;
    errorMessage = "";
    try {
      if (action === "accept") await window.phaseatlas.chat.acceptEdit(checkoutId, editId);
      else await window.phaseatlas.chat.discardEdit(checkoutId, editId);
      await refreshEdits();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "The edit could not be resolved.";
    } finally {
      editBusy = false;
    }
  }

  async function submit() {
    if (chatMode === "edit") await prepareEdit();
    else await send();
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
      await refreshEdits();
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
    void submit();
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

  {#if preparedEdit}
    <div class="edit-confirm" role="alertdialog" aria-label="Confirm isolated edit">
      <p><strong>Confirm isolated edit</strong></p>
      <dl>
        <div><dt>Repository</dt><dd>{preparedEdit.repositoryName} · {preparedEdit.baseRevision.slice(0, 8)}</dd></div>
        <div><dt>Provider</dt><dd>{preparedEdit.runnerId} · {preparedEdit.model}</dd></div>
        <div><dt>Boundary</dt><dd>Isolated worktree · review required before anything is applied</dd></div>
      </dl>
      <div class="edit-confirm-actions">
        <button type="button" onclick={() => preparedEdit = null}>Cancel</button>
        <button class="primary" type="button" disabled={editBusy} onclick={() => preparedEdit && startPreparedEdit(preparedEdit)}>Start edit</button>
      </div>
    </div>
  {/if}

  {#if reviewEdit}
    <div class="edit-review">
      <p><strong>Edit ready for review</strong><span>{reviewEdit.changedFiles.length} changed {reviewEdit.changedFiles.length === 1 ? "file" : "files"}</span></p>
      <p class="edit-review-summary">{reviewEdit.summary}</p>
      <div class="edit-confirm-actions">
        <button type="button" disabled={editBusy} onclick={() => resolveEdit(reviewEdit.editId, "discard")}>Discard</button>
        <button class="primary" type="button" disabled={editBusy} onclick={() => resolveEdit(reviewEdit.editId, "accept")}>Accept</button>
      </div>
    </div>
  {/if}

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
          : chatMode === "edit"
            ? "Describe the change — it runs in an isolated worktree and waits for your review"
            : "Ask about this task — the agent sees the contract and every completed stage"
        : "Choose an available CLI and model first"}
      disabled={composerBlocked}
    ></textarea>
    <div class="conversation-composer-actions">
      <div class="composer-mode" aria-label="Agent mode">
        <button class:active={chatMode === "ask"} type="button" aria-pressed={chatMode === "ask"} onclick={() => chatMode = "ask"} disabled={editBusy}>Ask</button>
        <button class:active={chatMode === "edit"} type="button" aria-pressed={chatMode === "edit"} onclick={() => chatMode = "edit"} disabled={editBusy}>Edit</button>
      </div>
      {#if chatMode === "edit"}
        <label class="composer-access">
          <span class="sr-only">Edit access mode</span>
          <select bind:value={editAccessMode} disabled={editBusy}>
            <option value="ask_for_approval">Ask for approval</option>
            <option value="full_access">Full access</option>
          </select>
        </label>
      {/if}
      <small>{chatMode === "edit" ? "Isolated worktree · review before apply" : "Read-only"}</small>
      <button class="composer-send" type="button" onclick={submit} disabled={!canSend}>{chatMode === "edit" ? "Start edit" : "Send"}<kbd>↵</kbd></button>
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
  .conversation-composer-actions small { margin-left: auto; }
  .composer-mode { display: inline-flex; align-items: center; border: 1px solid var(--border); border-radius: 8px; padding: 2px; background: var(--surface-soft); }
  .composer-mode button { border: 0; border-radius: 6px; padding: 3px 9px; background: transparent; color: var(--text-subtle); font-size: 10.5px; font-weight: 750; }
  .composer-mode button.active { background: var(--surface); color: var(--active-text); }
  .composer-access select { border: 1px solid var(--border); border-radius: var(--radius-xs); padding: 3px 6px; background: var(--surface-soft); color: var(--text-muted); font-family: inherit; font-size: 10.5px; }
  .edit-confirm,.edit-review { border: 1px solid var(--brand-200); border-radius: var(--radius); padding: 9px 11px; background: var(--active-surface); }
  .edit-confirm p,.edit-review p { margin: 0; font-size: 12px; }
  .edit-review p span { margin-left: 8px; color: var(--text-subtle); font-size: 10.5px; }
  .edit-review-summary { margin-top: 5px !important; color: var(--text-muted); line-height: 1.55; }
  .edit-confirm dl { display: grid; gap: 3px; margin: 7px 0; }
  .edit-confirm dl div { display: flex; gap: 8px; }
  .edit-confirm dt { color: var(--text-subtle); font-size: 10px; min-width: 78px; }
  .edit-confirm dd { margin: 0; font-size: 11px; }
  .edit-confirm-actions { display: flex; justify-content: flex-end; gap: 7px; margin-top: 8px; }
  .edit-confirm-actions button { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 4px 10px; background: var(--surface); color: var(--text); font-size: 11px; font-weight: 700; }
  .edit-confirm-actions button.primary { border-color: transparent; background: var(--brand-600); color: #fff; }
  .conversation-composer-actions button.composer-send { display: flex; align-items: center; gap: 7px; border: 0; border-radius: var(--radius-sm); padding: 5px 9px; background: var(--brand-600); color: #fff; font-size: 11px; font-weight: 800; }
  .conversation-composer-actions button:disabled { opacity: .4; }
  .conversation-composer-actions kbd { border-left: 1px solid rgba(255,255,255,.28); padding-left: 6px; font: inherit; }
</style>
