<script lang="ts">
  import { onMount, tick } from "svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import type { RendererComponent, Renderers } from "@humanspeak/svelte-markdown";
  import { markedMermaid, MermaidRenderer } from "@humanspeak/svelte-markdown/extensions";
  import type {
    ChatEditConfirmation,
    ChatEditAccessMode,
    ChatEditResult,
    PersistedRepositoryChatEvent,
    RepositoryChatAttachment,
    RepositoryChatImageAttachment,
    RepositoryChatImageMediaType,
    RepositoryChatMessage,
    RepositoryChatSession,
    RepositoryChatTurn,
    RepositoryFileEntry,
    RunnerDescriptor,
  } from "@phaseatlas/contracts";

  export let checkoutId: string;
  export let repositoryName: string;
  export let runners: RunnerDescriptor[] = [];
  export let runnerId = "";
  export let modelId = "";
  export let reasoningEffort = "";
  export let active = true;
  export let terminalOpen = false;
  export let terminalHeight = 300;
  export let terminalShortcutLabel = "⌘`";
  export let onClose: () => void = () => undefined;
  export let onShowAgentConfiguration: () => void = () => undefined;
  export let onOpenExplorer: () => void = () => undefined;
  export let onToggleTerminal: () => void = () => undefined;
  export let onCreateTaskProposal: (request: string) => void = () => undefined;

  type Activity = {
    id: string;
    kind: "tool" | "reasoning" | "file";
    label: string;
    summary: string;
    output: string;
    status: "running" | "completed" | "failed";
    sequence: number;
  };

  type AssistantSegment = {
    id: string;
    kind: "assistant";
    text: string;
    sequence: number;
  };

  type TimelineItem = AssistantSegment | Activity;

  type TranscriptScrollPosition = {
    top: number;
    atTail: boolean;
  };

  type MentionResult = RepositoryFileEntry & { score: number };

  const ACTIVE = new Set(["starting", "running"]);
  const TERMINAL_EVENTS = new Set(["chat.turn.completed", "chat.turn.failed", "chat.turn.cancelled", "chat.turn.interrupted"]);
  const IMAGE_MEDIA_TYPES = new Set<RepositoryChatImageMediaType>(["image/png", "image/jpeg", "image/webp", "image/gif"]);
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const EDIT_ACCESS_MODE_STORAGE_KEY = "phaseatlas.chat.edit-access-mode.v1";
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
  let repositoryEntries: RepositoryFileEntry[] = [];
  let repositoryIndexLoading = false;
  let repositoryIndexLoaded = false;
  let repositoryIndexError = "";
  let repositoryIndexGeneration = 0;
  let mentionOpen = false;
  let mentionQuery = "";
  let mentionStart = -1;
  let mentionEnd = -1;
  let mentionSelection = 0;
  let renamingSessionId = "";
  let renameDraft = "";
  let errorMessage = "";
  let transcript: HTMLDivElement;
  let composerElement: HTMLTextAreaElement;
  let imageInput: HTMLInputElement;
  let chatShellElement: HTMLElement;
  let clock = Date.now();
  let loadGeneration = 0;
  let chatMode: "ask" | "edit" = "ask";
  let editAccessMode: ChatEditAccessMode = "ask_for_approval";
  let preparedEdit: ChatEditConfirmation | null = null;
  let edits: ChatEditResult[] = [];
  let editBusy = false;
  let tailFrame = 0;
  let scrollPersistTimer = 0;
  let scrollRestoreGeneration = 0;
  let restoringScrollForSession = "";
  const scrollBySession = new Map<string, TranscriptScrollPosition>();

  $: selectedSession = sessions.find((session) => session.sessionId === selectedSessionId) ?? null;
  $: selectedMessages = selectedSessionId ? messagesBySession[selectedSessionId] ?? [] : [];
  $: selectedTurns = selectedSessionId ? turnsBySession[selectedSessionId] ?? [] : [];
  $: selectedRunner = runners.find((runner) => runner.id === runnerId);
  $: selectedModel = selectedRunner?.models.find((model) => model.id === modelId);
  $: providerReady = Boolean(selectedRunner?.available && selectedModel);
  $: activeTurn = [...selectedTurns].reverse().find((turn) => ACTIVE.has(turn.status)) ?? null;
  $: activeEdit = edits.find((edit) => edit.status === "running") ?? null;
  $: reviewEditResult = edits.find((edit) => edit.status === "completed" && edit.disposition === "pending_review") ?? null;
  $: retainedEditResult = edits.find((edit) => edit.status === "completed" && edit.disposition === "retained") ?? null;
  $: canSend = Boolean(selectedSession?.state === "open" && providerReady && (composer.trim() || attachments.length) && !sending && !activeTurn && chatMode === "ask");
  $: mentionResults = rankedMentionResults(repositoryEntries, mentionQuery);
  $: if (mentionSelection >= mentionResults.length) mentionSelection = Math.max(mentionResults.length - 1, 0);

  onMount(() => {
    const savedAccessMode = window.localStorage.getItem(EDIT_ACCESS_MODE_STORAGE_KEY);
    if (savedAccessMode === "ask_for_approval" || savedAccessMode === "full_access") editAccessMode = savedAccessMode;
    const syncAccessMode = (event: StorageEvent) => {
      if (event.key === EDIT_ACCESS_MODE_STORAGE_KEY && (event.newValue === "ask_for_approval" || event.newValue === "full_access")) {
        editAccessMode = event.newValue;
        preparedEdit = null;
      }
    };
    window.addEventListener("storage", syncAccessMode);
    const timer = window.setInterval(() => clock = Date.now(), 1_000);
    const unsubscribe = window.phaseatlas?.events.subscribe((event) => {
      if (event.type === "repository.changed" && event.checkoutId === checkoutId) {
        repositoryIndexGeneration += 1;
        repositoryEntries = [];
        repositoryIndexLoaded = false;
        repositoryIndexLoading = false;
        repositoryIndexError = "";
        if (mentionOpen) void loadRepositoryIndex();
        return;
      }
      if (event.type === "chat.edit.event" && event.checkoutId === checkoutId) {
        void refreshEdits();
        return;
      }
      if (event.type !== "chat.turn.event" || event.checkoutId !== checkoutId) return;
      void receiveEvent(event.turnId, event.event);
    });
    void loadSessions();
    return () => {
      rememberTranscriptScroll();
      repositoryIndexGeneration += 1;
      window.cancelAnimationFrame(tailFrame);
      window.clearTimeout(scrollPersistTimer);
      window.clearInterval(timer);
      window.removeEventListener("storage", syncAccessMode);
      unsubscribe?.();
    };
  });

  function selectionKey() {
    return `phaseatlas.chat.selected-session.v1.${checkoutId}`;
  }

  function scrollPositionKey(sessionId: string) {
    return `phaseatlas.chat.scroll-position.v1.${checkoutId}.${sessionId}`;
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
      if (next) await loadSession(next.sessionId, generation);
      else selectedSessionId = "";
      await refreshEdits();
    } catch (error) {
      showError(error);
    } finally {
      if (generation === loadGeneration) loading = false;
    }
  }

  async function loadSession(sessionId: string, generation = loadGeneration) {
    if (!window.phaseatlas) return;
    if (selectedSessionId && selectedSessionId !== sessionId) rememberTranscriptScroll();
    const scrollGeneration = ++scrollRestoreGeneration;
    restoringScrollForSession = sessionId;
    selectedSessionId = sessionId;
    window.localStorage.setItem(selectionKey(), sessionId);
    const [messages, turns] = await Promise.all([
      window.phaseatlas.chat.listMessages(checkoutId, sessionId),
      window.phaseatlas.chat.listTurns(checkoutId, sessionId),
    ]);
    if (generation !== loadGeneration || selectedSessionId !== sessionId) {
      if (scrollGeneration === scrollRestoreGeneration) restoringScrollForSession = "";
      return;
    }
    messagesBySession = { ...messagesBySession, [sessionId]: messages };
    turnsBySession = { ...turnsBySession, [sessionId]: turns };
    await Promise.all(turns.map((turn) => replayTurn(turn.turnId)));
    await refreshEdits();
    await restoreTranscriptScroll(sessionId, scrollGeneration);
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
  }

  async function receiveEvent(turnId: string, event: PersistedRepositoryChatEvent) {
    const shouldFollowTail = isNearTranscriptTail();
    const cursor = cursorByTurn[turnId] ?? 0;
    if (event.sequence > cursor + 1) await replayTurn(turnId);
    mergeEvents(turnId, [event]);
    const turn = Object.values(turnsBySession).flat().find((candidate) => candidate.turnId === turnId);
    if (turn && TERMINAL_EVENTS.has(event.type)) {
      await refreshSession(turn.sessionId);
      sessions = await window.phaseatlas!.chat.listSessions(checkoutId);
    }
    if (turn?.sessionId === selectedSessionId && shouldFollowTail) scheduleTailFollow();
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
        ...(reasoningEffort ? { reasoningEffort } : {}),
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
    if (sessionId === selectedSessionId) return;
    await loadSession(sessionId);
  }

  async function sendMessage() {
    if (!window.phaseatlas || !selectedSession || !canSend) return;
    const text = composer.trim();
    const submittedAttachments = attachments;
    composer = "";
    attachments = [];
    closeMentionPicker();
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

  async function refreshEdits() {
    if (!window.phaseatlas || !selectedSessionId) return;
    try {
      edits = await window.phaseatlas.chat.listEdits(checkoutId, selectedSessionId);
    } catch (error) {
      showError(error);
    }
  }

  function changeEditAccessMode(event: Event) {
    const mode = (event.currentTarget as HTMLSelectElement).value as ChatEditAccessMode;
    if (mode !== "ask_for_approval" && mode !== "full_access") return;
    editAccessMode = mode;
    preparedEdit = null;
    window.localStorage.setItem(EDIT_ACCESS_MODE_STORAGE_KEY, mode);
  }

  async function prepareEdit() {
    if (!window.phaseatlas || !selectedSession || !composer.trim() || editBusy) return;
    editBusy = true;
    errorMessage = "";
    try {
      const submittedAttachments = attachments;
      const confirmation = await window.phaseatlas.chat.prepareEdit(checkoutId, {
        sessionId: selectedSession.sessionId,
        prompt: composer.trim(),
        accessMode: editAccessMode,
        ...(submittedAttachments.length ? { attachments: submittedAttachments } : {}),
      });
      if (editAccessMode === "full_access") {
        try {
          await startPreparedEdit(confirmation);
        } catch (error) {
          preparedEdit = confirmation;
          throw error;
        }
      } else {
        preparedEdit = confirmation;
      }
    } catch (error) {
      showError(error);
    } finally {
      editBusy = false;
    }
  }

  async function confirmEdit() {
    if (!window.phaseatlas || !preparedEdit || editBusy) return;
    editBusy = true;
    try {
      await startPreparedEdit(preparedEdit);
    } catch (error) {
      showError(error);
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
    attachments = [];
    preparedEdit = null;
    await refreshEdits();
  }

  async function reviewEdit(editId: string, action: "accept" | "discard" | "retain") {
    if (!window.phaseatlas || editBusy) return;
    editBusy = true;
    try {
      const result = action === "accept" ? await window.phaseatlas.chat.acceptEdit(checkoutId, editId)
        : action === "discard" ? await window.phaseatlas.chat.discardEdit(checkoutId, editId)
          : await window.phaseatlas.chat.retainEdit(checkoutId, editId);
      edits = edits.map((edit) => edit.editId === editId ? result : edit);
    } catch (error) {
      showError(error);
    } finally {
      editBusy = false;
    }
  }

  async function recoverEdit(editId: string, decision: "resume_review" | "discard") {
    if (!window.phaseatlas || editBusy) return;
    editBusy = true;
    try {
      const result = await window.phaseatlas.chat.recoverEdit(checkoutId, { editId, decision });
      edits = edits.map((edit) => edit.editId === editId ? result : edit);
    } catch (error) {
      showError(error);
    } finally {
      editBusy = false;
    }
  }

  function handoffToPlanning() {
    const transcript = selectedMessages.slice(-12).map((message) => `${message.role === "user" ? "User" : "Agent"}: ${message.content}`).join("\n\n");
    onCreateTaskProposal(`Create a reviewed canonical task proposal from this repository conversation. Treat the transcript as advisory context and do not mark any task complete.\n\n${transcript}`);
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

  function rankedMentionResults(entries: RepositoryFileEntry[], query: string): MentionResult[] {
    const normalizedQuery = query.trim().replace(/^\.\//, "").toLowerCase();
    const terms = normalizedQuery.split(/[\s/]+/).filter(Boolean);
    return entries
      .flatMap((entry): MentionResult[] => {
        const name = entry.name.toLowerCase();
        const path = entry.path.toLowerCase();
        if (terms.some((term) => !path.includes(term))) return [];
        const score = !normalizedQuery ? entry.path.split("/").length * 10
          : name === normalizedQuery ? 0
            : name.startsWith(normalizedQuery) ? 10
              : path.startsWith(normalizedQuery) ? 20
                : name.includes(normalizedQuery) ? 30
                  : 40;
        return [{ ...entry, score: score + entry.path.split("/").length + (entry.type === "directory" ? 0 : 1) }];
      })
      .sort((left, right) => left.score - right.score || left.path.localeCompare(right.path))
      .slice(0, 12);
  }

  async function loadRepositoryIndex() {
    if (!window.phaseatlas || repositoryIndexLoading || repositoryIndexLoaded) return;
    const generation = ++repositoryIndexGeneration;
    const indexed = new Map<string, RepositoryFileEntry>();
    const directories = [""];
    let skippedDirectories = 0;
    repositoryIndexLoading = true;
    repositoryIndexError = "";
    try {
      while (directories.length && indexed.size < 5_000) {
        const batch = directories.splice(0, 8);
        const pages = await Promise.all(batch.map(async (directory) => {
          try {
            return await window.phaseatlas!.files.list(checkoutId, directory);
          } catch (error) {
            if (!directory) throw error;
            skippedDirectories += 1;
            return [];
          }
        }));
        if (generation !== repositoryIndexGeneration) return;
        for (const entry of pages.flat()) {
          if (indexed.size >= 5_000) break;
          indexed.set(entry.path, entry);
          if (entry.type === "directory") directories.push(entry.path);
        }
        repositoryEntries = [...indexed.values()];
      }
      repositoryIndexLoaded = true;
      if (indexed.size >= 5_000) repositoryIndexError = "Showing matches from the first 5,000 repository paths.";
      else if (skippedDirectories) repositoryIndexError = `${skippedDirectories} inaccessible ${skippedDirectories === 1 ? "folder was" : "folders were"} skipped.`;
    } catch (error) {
      repositoryIndexError = error instanceof Error ? error.message : "Repository paths could not be indexed.";
    } finally {
      if (generation === repositoryIndexGeneration) repositoryIndexLoading = false;
    }
  }

  function closeMentionPicker() {
    mentionOpen = false;
    mentionQuery = "";
    mentionStart = -1;
    mentionEnd = -1;
    mentionSelection = 0;
  }

  function updateMentionFromComposer(element = composerElement) {
    if (!element || element.disabled) {
      closeMentionPicker();
      return;
    }
    const cursor = element.selectionStart ?? element.value.length;
    const beforeCursor = element.value.slice(0, cursor);
    const match = beforeCursor.match(/(^|[\s([{])@([^@\s]*)$/);
    if (!match) {
      closeMentionPicker();
      return;
    }
    mentionStart = cursor - (match[2]?.length ?? 0) - 1;
    mentionEnd = cursor;
    mentionQuery = match[2] ?? "";
    mentionSelection = 0;
    mentionOpen = true;
    void loadRepositoryIndex();
  }

  async function openMentionPicker() {
    if (!composerElement || composerElement.disabled) return;
    const start = composerElement.selectionStart ?? composer.length;
    const end = composerElement.selectionEnd ?? start;
    const leadingSpace = start > 0 && !/[\s([{]/.test(composer[start - 1] ?? "") ? " " : "";
    const insertion = `${leadingSpace}@`;
    composer = `${composer.slice(0, start)}${insertion}${composer.slice(end)}`;
    mentionStart = start + leadingSpace.length;
    mentionEnd = mentionStart + 1;
    mentionQuery = "";
    mentionSelection = 0;
    mentionOpen = true;
    void loadRepositoryIndex();
    await tick();
    composerElement.focus();
    composerElement.setSelectionRange(mentionEnd, mentionEnd);
  }

  function attachRepositoryPath(path: string) {
    if (attachments.some((attachment) => attachment.type !== "image" && attachment.path === path)) return true;
    if (attachments.length >= 12) {
      errorMessage = "A chat message can mention at most 12 repository paths.";
      return false;
    }
    attachments = [...attachments, { path }];
    return true;
  }

  async function chooseMention(entry: RepositoryFileEntry) {
    if (mentionStart < 0 || mentionEnd < mentionStart) return;
    if (!attachRepositoryPath(entry.path)) return;
    const renderedPath = `${entry.path}${entry.type === "directory" ? "/" : ""}`;
    const replacement = `@${renderedPath} `;
    const cursor = mentionStart + replacement.length;
    composer = `${composer.slice(0, mentionStart)}${replacement}${composer.slice(mentionEnd)}`;
    closeMentionPicker();
    await tick();
    composerElement?.focus();
    composerElement?.setSelectionRange(cursor, cursor);
  }

  async function revealMentionSelection() {
    await tick();
    document.getElementById(`repository-mention-${mentionSelection}`)?.scrollIntoView({ block: "nearest" });
  }

  function handleComposerInput(event: Event) {
    if (!(event.currentTarget instanceof HTMLTextAreaElement)) return;
    composer = event.currentTarget.value;
    updateMentionFromComposer(event.currentTarget);
  }

  function handleComposerCaret(event: KeyboardEvent) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    updateMentionFromComposer(event.currentTarget instanceof HTMLTextAreaElement ? event.currentTarget : composerElement);
  }

  function handleComposerBlur() {
    window.setTimeout(() => {
      if (!document.activeElement?.closest(".composer-stack")) closeMentionPicker();
    });
  }

  function addAttachment() {
    const path = attachmentDraft.trim().replaceAll("\\", "/").replace(/^\.\//, "");
    if (!path || path.startsWith("/") || path.split("/").includes("..") || path === ".git" || path.startsWith(".git/")) {
      errorMessage = "Use a safe repository-relative file path.";
      return;
    }
    attachRepositoryPath(path);
    attachmentDraft = "";
  }

  function isImageAttachment(attachment: RepositoryChatAttachment): attachment is RepositoryChatImageAttachment {
    return attachment.type === "image";
  }

  function imageUrl(attachment: RepositoryChatImageAttachment) {
    return `data:${attachment.mediaType};base64,${attachment.data}`;
  }

  function imageSize(attachment: RepositoryChatImageAttachment) {
    const bytes = imageBytes(attachment);
    return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(Math.round(bytes / 1024), 1)} KB`;
  }

  function imageBytes(attachment: RepositoryChatImageAttachment) {
    return Math.floor(attachment.data.length * 3 / 4) - (attachment.data.endsWith("==") ? 2 : attachment.data.endsWith("=") ? 1 : 0);
  }

  function fileData(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`Could not read ${file.name || "pasted image"}.`));
      reader.onload = () => {
        const result = typeof reader.result === "string" ? reader.result : "";
        const comma = result.indexOf(",");
        if (comma < 0) reject(new Error(`Could not encode ${file.name || "pasted image"}.`));
        else resolve(result.slice(comma + 1));
      };
      reader.readAsDataURL(file);
    });
  }

  async function addImageFiles(files: File[]) {
    if (!files.length) return;
    if (!providerReady || selectedSession?.state !== "open") {
      errorMessage = "Open a conversation with an available provider before attaching images.";
      return;
    }
    const currentImages = attachments.filter(isImageAttachment).length;
    if (currentImages + files.length > 4) {
      errorMessage = "A chat message can include at most 4 images.";
      return;
    }
    if (attachments.length + files.length > 12) {
      errorMessage = "A chat message can include at most 12 attachments.";
      return;
    }
    const existingImageBytes = attachments.filter(isImageAttachment).reduce((total, attachment) => total + imageBytes(attachment), 0);
    if (existingImageBytes + files.reduce((total, file) => total + file.size, 0) > 16 * 1024 * 1024) {
      errorMessage = "Chat images exceed the 16 MB combined limit.";
      return;
    }
    const added: RepositoryChatImageAttachment[] = [];
    try {
      for (const [index, file] of files.entries()) {
        if (!IMAGE_MEDIA_TYPES.has(file.type as RepositoryChatImageMediaType)) {
          throw new Error(`${file.name || "Pasted image"} must be PNG, JPEG, WebP, or GIF.`);
        }
        if (file.size > MAX_IMAGE_BYTES) throw new Error(`${file.name || "Pasted image"} exceeds the 5 MB limit.`);
        const data = await fileData(file);
        const name = file.name || `pasted-image-${Date.now()}-${index + 1}.${file.type === "image/jpeg" ? "jpg" : file.type.split("/")[1]}`;
        const duplicate = [...attachments, ...added].some((attachment) =>
          isImageAttachment(attachment) && attachment.mediaType === file.type && attachment.data === data);
        if (!duplicate) added.push({ type: "image", name, mediaType: file.type as RepositoryChatImageMediaType, data });
      }
      attachments = [...attachments, ...added];
      errorMessage = "";
    } catch (error) {
      showError(error);
    }
  }

  function chooseImages(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    void addImageFiles(Array.from(input.files ?? []));
    input.value = "";
  }

  function handleComposerPaste(event: ClipboardEvent) {
    const itemImages = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .flatMap((item) => {
        const file = item.getAsFile();
        return file ? [file] : [];
      });
    const images = itemImages.length
      ? itemImages
      : Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    event.preventDefault();
    void addImageFiles(images);
  }

  function removeAttachment(index: number) {
    attachments = attachments.filter((_, attachmentIndex) => attachmentIndex !== index);
  }

  function userMessage(turn: RepositoryChatTurn) {
    return selectedMessages.find((message) => message.messageId === turn.userMessageId);
  }

  function assistantMessage(turn: RepositoryChatTurn) {
    return selectedMessages.find((message) => message.messageId === turn.assistantMessageId);
  }

  function formatByteCount(value: number) {
    if (value < 1_024) return `${value} B`;
    if (value < 1_048_576) return `${(value / 1_024).toFixed(value < 10_240 ? 1 : 0)} KB`;
    return `${(value / 1_048_576).toFixed(value < 10_485_760 ? 1 : 0)} MB`;
  }

  function turnTimeline(events: PersistedRepositoryChatEvent[], fallbackAnswer = ""): TimelineItem[] {
    const timeline: TimelineItem[] = [];
    const activityById = new Map<string, Activity>();
    const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
    for (const event of ordered) {
      if (event.type === "chat.assistant.delta") {
        const text = typeof event.payload.text === "string" ? event.payload.text : "";
        if (!text) continue;
        const previous = timeline.at(-1);
        if (previous?.kind === "assistant") previous.text += text;
        else timeline.push({ id: `assistant-${event.sequence}`, kind: "assistant", text, sequence: event.sequence });
        continue;
      }
      if (event.type === "chat.reasoning") {
        const providerItemId = typeof event.payload.itemId === "string" ? event.payload.itemId : `${event.sequence}`;
        const id = `reasoning-${providerItemId}`;
        const delta = typeof event.payload.summary === "string" ? event.payload.summary : "";
        const status = event.payload.status === "running" ? "running" : "completed";
        const existing = activityById.get(id);
        if (existing) {
          existing.output += delta;
          existing.summary = existing.output.trim().slice(0, 140) || "Reasoning summary";
          existing.status = status;
        } else {
          const activity: Activity = {
            id, kind: "reasoning", label: "Reasoning",
            summary: delta.trim().slice(0, 140) || "Reasoning summary",
            output: delta,
            status,
            sequence: event.sequence,
          };
          activityById.set(id, activity);
          timeline.push(activity);
        }
        continue;
      }
      if (event.type === "chat.file.reference") {
        const activity: Activity = {
          id: `file-${event.sequence}`, kind: "file", label: "Repository file",
          summary: String(event.payload.path ?? "File reference"), output: "", status: "completed", sequence: event.sequence,
        };
        activityById.set(activity.id, activity);
        timeline.push(activity);
        continue;
      }
      if (event.type === "chat.tool.started") {
        const id = String(event.payload.toolCallId ?? `tool-${event.sequence}`);
        const activity: Activity = {
          id, kind: "tool", label: String(event.payload.tool ?? "Tool"),
          summary: String(event.payload.summary ?? "Inspecting repository"), output: "", status: "running", sequence: event.sequence,
        };
        activityById.set(id, activity);
        timeline.push(activity);
        continue;
      }
      if (event.type === "chat.tool.completed") {
        const id = String(event.payload.toolCallId ?? `tool-${event.sequence}`);
        let item = activityById.get(id);
        if (!item) {
          item = {
            id, kind: "tool", label: "Tool", summary: "Repository command",
            output: "", status: "running", sequence: event.sequence,
          };
          activityById.set(id, item);
          timeline.push(item);
        }
        item.status = event.payload.status === "failed" ? "failed" : "completed";
        const outputBytes = Number(event.payload.outputBytes);
        if (event.payload.outputHidden === true && Number.isFinite(outputBytes) && outputBytes > 0) {
          item.summary = `${item.summary} · ${formatByteCount(outputBytes)} output hidden`;
        }
      }
    }
    if (!timeline.some((item) => item.kind === "assistant") && fallbackAnswer) {
      timeline.push({
        id: "assistant-fallback",
        kind: "assistant",
        text: fallbackAnswer,
        sequence: (ordered.at(-1)?.sequence ?? 0) + 1,
      });
    }
    return timeline;
  }

  function timelineAnswer(items: TimelineItem[]) {
    return items
      .filter((item): item is AssistantSegment => item.kind === "assistant")
      .map((item) => item.text)
      .join("");
  }

  function isLastAssistant(items: TimelineItem[], index: number) {
    return !items.slice(index + 1).some((item) => item.kind === "assistant");
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

  function handleComposerKeydown(event: KeyboardEvent) {
    if (mentionOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (mentionResults.length) {
          const direction = event.key === "ArrowDown" ? 1 : -1;
          mentionSelection = (mentionSelection + direction + mentionResults.length) % mentionResults.length;
          void revealMentionSelection();
        }
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.isComposing) {
        event.preventDefault();
        const selected = mentionResults[mentionSelection];
        if (selected) void chooseMention(selected);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeMentionPicker();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (chatMode === "edit") void prepareEdit();
      else void sendMessage();
    }
  }

  function handleWindowKeydown(event: KeyboardEvent) {
    if (!active) return;
    if (chatShellElement && !chatShellElement.contains(document.activeElement)) return;
    if (event.defaultPrevented) return;
    if (event.key === "Escape" && mentionOpen) {
      event.preventDefault();
      closeMentionPicker();
      composerElement?.focus();
      return;
    }
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

  function storedTranscriptScroll(sessionId: string) {
    const remembered = scrollBySession.get(sessionId);
    if (remembered) return remembered;
    try {
      const stored = window.localStorage.getItem(scrollPositionKey(sessionId));
      if (!stored) return null;
      const parsed = JSON.parse(stored) as Partial<TranscriptScrollPosition>;
      if (typeof parsed.top !== "number" || !Number.isFinite(parsed.top) || typeof parsed.atTail !== "boolean") return null;
      return { top: Math.max(0, parsed.top), atTail: parsed.atTail };
    } catch {
      return null;
    }
  }

  function rememberTranscriptScroll() {
    const snapshot = captureTranscriptScroll();
    if (!snapshot) return;
    persistTranscriptScroll(snapshot.sessionId, snapshot.position);
  }

  function captureTranscriptScroll() {
    if (!transcript || !selectedSessionId || restoringScrollForSession === selectedSessionId) return null;
    const maxTop = Math.max(0, transcript.scrollHeight - transcript.clientHeight);
    const position = {
      top: Math.min(Math.max(0, transcript.scrollTop), maxTop),
      atTail: maxTop - transcript.scrollTop < 120,
    };
    scrollBySession.set(selectedSessionId, position);
    return { sessionId: selectedSessionId, position };
  }

  function persistTranscriptScroll(sessionId: string, position: TranscriptScrollPosition) {
    try {
      window.localStorage.setItem(scrollPositionKey(sessionId), JSON.stringify(position));
    } catch {
      // Scroll persistence is a convenience; private storage modes may reject it.
    }
  }

  function handleTranscriptScroll() {
    const snapshot = captureTranscriptScroll();
    if (!snapshot) return;
    window.clearTimeout(scrollPersistTimer);
    scrollPersistTimer = window.setTimeout(() => {
      scrollPersistTimer = 0;
      persistTranscriptScroll(snapshot.sessionId, scrollBySession.get(snapshot.sessionId) ?? snapshot.position);
    }, 160);
  }

  async function restoreTranscriptScroll(sessionId: string, generation: number) {
    await tick();
    if (!transcript || selectedSessionId !== sessionId || generation !== scrollRestoreGeneration) return;
    const position = storedTranscriptScroll(sessionId);
    const top = !position || position.atTail
      ? transcript.scrollHeight
      : Math.min(position.top, Math.max(0, transcript.scrollHeight - transcript.clientHeight));
    transcript.scrollTo({ top, behavior: "auto" });
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    if (selectedSessionId !== sessionId || generation !== scrollRestoreGeneration) return;
    restoringScrollForSession = "";
    rememberTranscriptScroll();
  }

  function isNearTranscriptTail() {
    if (!transcript) return true;
    return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 120;
  }

  function scheduleTailFollow() {
    if (tailFrame) return;
    tailFrame = window.requestAnimationFrame(() => {
      tailFrame = 0;
      void scrollToTail(false);
    });
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

<div
  class="chat-layer"
  class:inactive={!active}
  role="dialog"
  aria-modal={active}
  aria-hidden={!active}
  aria-labelledby="repository-chat-title"
  style={`--chat-terminal-inset: ${terminalOpen ? terminalHeight : 0}px`}
>
  <section class="chat-shell" bind:this={chatShellElement} onpaste={handleComposerPaste}>
    <header class="chat-header">
      <div class="chat-mark" aria-hidden="true"><span></span><span></span><span></span></div>
      <div class="chat-title">
        <p>Repository intelligence</p>
        <h2 id="repository-chat-title">Agent chat <span>/ {repositoryName}</span></h2>
      </div>
      <button class="provider-chip" class:unavailable={!providerReady} type="button" title="Show agent configuration" onclick={onShowAgentConfiguration}>
        <span></span>
        <div><small>{selectedRunner?.name ?? "Provider unavailable"}</small><strong>{selectedModel?.displayName ?? "Select a discovered model"}</strong></div>
      </button>
      <button class="explorer-chip" type="button" title="Open repository file explorer" onclick={onOpenExplorer}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4zM8 5v14M11 9h6M11 13h4"/></svg>
        Explorer
      </button>
      <button class:active={terminalOpen} class="explorer-chip" type="button" title={`Toggle terminal (${terminalShortcutLabel})`} onclick={onToggleTerminal}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 7 4.5 5L5 17M12 17h7"/></svg>
        Terminal
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
                    <span><strong>{session.title}</strong><small>{session.runnerId}{session.reasoningEffort ? ` · ${session.reasoningEffort}` : ""} · {relativeTime(session.updatedAt)}</small></span>
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
            <div class="conversation-controls">
              <div class="mode-switch" aria-label="Chat mode"><button class:active={chatMode === "ask"} type="button" onclick={() => { chatMode = "ask"; preparedEdit = null; }}>Ask</button><button class:active={chatMode === "edit"} type="button" onclick={() => chatMode = "edit"}>Edit</button></div>
              <button class="task-handoff" type="button" onclick={handoffToPlanning} disabled={!selectedMessages.length}>Create task</button>
              <div class="conversation-meta"><span>{selectedTurns.length} {selectedTurns.length === 1 ? "turn" : "turns"}</span><span>Updated {relativeTime(selectedSession.updatedAt)}</span></div>
            </div>
          </header>

          <div class="transcript" bind:this={transcript} onscroll={handleTranscriptScroll} aria-live="polite" aria-label="Conversation transcript">
            {#if selectedTurns.length}
              <div class="transcript-column">
                {#each selectedTurns as turn (turn.turnId)}
                  {@const prompt = userMessage(turn)}
                  {@const answer = assistantMessage(turn)}
                  {@const turnEvents = eventsByTurn[turn.turnId] ?? []}
                  {@const timeline = turnTimeline(turnEvents, answer?.content ?? "")}
                  {@const responseText = answer?.content ?? timelineAnswer(timeline)}
                  <section class="turn" data-status={turn.status}>
                    {#if prompt}
                      <article class="message user-message">
                        <header><span>You</span><time datetime={prompt.createdAt}>{relativeTime(prompt.createdAt)}</time></header>
                        <p>{prompt.content}</p>
                        {#if prompt.attachments.length}
                          <div class="message-attachments">
                            {#each prompt.attachments as attachment}
                              {#if isImageAttachment(attachment)}
                                <figure class="message-image"><img src={imageUrl(attachment)} alt={attachment.name} /><figcaption><span>{attachment.name}</span><small>{imageSize(attachment)}</small></figcaption></figure>
                              {:else}
                                <code>{attachment.path}</code>
                              {/if}
                            {/each}
                          </div>
                        {/if}
                        {#if turn.parentTurnId}<small class="retry-note">Retried from an interrupted attempt</small>{/if}
                      </article>
                    {/if}

                    {#if timeline.length || ACTIVE.has(turn.status)}
                      <article class="message assistant-message">
                        <header><span><i></i>PhaseAtlas agent</span><div><time datetime={answer?.createdAt ?? turn.updatedAt}>{relativeTime(answer?.createdAt ?? turn.updatedAt)}</time>{#if responseText}<button type="button" aria-label="Copy assistant response" title="Copy response" onclick={() => copyText(responseText)}>Copy</button>{/if}</div></header>
                        <div class="turn-timeline">
                          {#each timeline as item, timelineIndex (item.id)}
                            {#if item.kind === "assistant"}
                              <div class="markdown-message assistant-segment" class:streaming={!answer && ACTIVE.has(turn.status) && isLastAssistant(timeline, timelineIndex)}>
                                <SvelteMarkdown source={item.text} extensions={markdownExtensions} renderers={markdownRenderers} sanitizeUrl={() => ""}>
                                  {#snippet link({ children })}<span class="rendered-link">{@render children?.()}</span>{/snippet}
                                  {#snippet image({ text })}<span class="rendered-image">[Image omitted: {text}]</span>{/snippet}
                                </SvelteMarkdown>
                              </div>
                            {:else}
                              <div class="timeline-activity" data-kind={item.kind} data-status={item.status}>
                                <span class="timeline-activity-icon" aria-hidden="true">
                                  <svg viewBox="0 0 20 20">
                                    {#if item.kind === "tool"}<path d="m3.5 5.5 4 4-4 4M9.5 13.5h7" />
                                    {:else if item.kind === "file"}<path d="M5 2.8h6l4 4v10.4H5zM11 2.8v4h4M7.8 10h4.8M7.8 13h4.8" />
                                    {:else}<circle cx="9" cy="9" r="5.5" /><path d="m13 13 3.5 3.5M7 9h4M9 7v4" />{/if}
                                  </svg>
                                </span>
                                <span class="timeline-activity-copy"><strong>{item.summary}</strong><small>{item.label}</small></span>
                                <i aria-label={item.status}></i>
                              </div>
                            {/if}
                          {/each}
                          {#if ACTIVE.has(turn.status) && !timeline.length}<div class="quiet-pulse inline"><span></span><p><strong>Agent process is running</strong><small>Waiting for the first event…</small></p></div>{/if}
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
            {#if preparedEdit}
              <section class="edit-confirmation" aria-label="Confirm isolated edit">
                <header><span>Approval required</span><strong>Isolated edit #{preparedEdit.editId.slice(0, 6)}</strong></header>
                <dl><div><dt>Repository</dt><dd>{preparedEdit.repositoryName} · {preparedEdit.baseRevision.slice(0, 8)}</dd></div><div><dt>Provider</dt><dd>{preparedEdit.runnerId} · {preparedEdit.model}{preparedEdit.reasoningEffort ? ` · ${preparedEdit.reasoningEffort}` : ""}</dd></div><div><dt>Repository access</dt><dd>Entire repository</dd></div><div><dt>Policy</dt><dd>Isolated worktree · network blocked · review before apply</dd></div></dl>
                <p>Nothing reaches the canonical checkout until you review the Git-derived diff and explicitly accept it.</p>
                <div><button type="button" onclick={() => preparedEdit = null}>Cancel</button><button class="confirm-edit" type="button" onclick={confirmEdit} disabled={editBusy}>{editBusy ? "Starting…" : "Confirm and start"}</button></div>
              </section>
            {/if}
            {#if activeEdit}
              <section class="edit-running" aria-live="polite"><span></span><p><strong>Editing in an isolated worktree</strong><small>The provider is active. PhaseAtlas will derive and validate the final diff.</small></p><button type="button" onclick={() => window.phaseatlas?.chat.cancelEdit(checkoutId, activeEdit!.editId)}>Stop</button></section>
            {/if}
            {#if reviewEditResult}
              <details class="edit-review" open>
                <summary><span>Review required</span><strong>{reviewEditResult.changedFiles.length} changed files</strong><small>{reviewEditResult.blockers.length ? `${reviewEditResult.blockers.length} blockers` : "Ready for review"}</small></summary>
                <p>{reviewEditResult.summary}</p>
                {#if reviewEditResult.changedFiles.length}<ul>{#each reviewEditResult.changedFiles as change}<li><code>{change.path}</code><span>{change.changeType}</span></li>{/each}</ul>{/if}
                {#if reviewEditResult.verification.length}<div class="edit-verification">{#each reviewEditResult.verification as check}<span data-status={check.status}><strong>{check.label}</strong><small>{check.details}</small></span>{/each}</div>{/if}
                {#if reviewEditResult.patch}<pre>{reviewEditResult.patch}</pre>{/if}
                {#if reviewEditResult.blockers.length}<div class="edit-blockers">{#each reviewEditResult.blockers as blocker}<span>{blocker}</span>{/each}</div>{/if}
                <div class="review-actions"><button type="button" onclick={() => reviewEdit(reviewEditResult!.editId, "discard")} disabled={editBusy}>Discard</button><button type="button" onclick={() => reviewEdit(reviewEditResult!.editId, "retain")} disabled={editBusy}>Retain</button><button type="button" onclick={() => { chatMode = "edit"; composer = `Continue the isolated edit after reviewing attempt ${reviewEditResult!.editId.slice(0, 8)}: `; }} disabled={editBusy}>Continue</button><button class="accept-edit" type="button" onclick={() => reviewEdit(reviewEditResult!.editId, "accept")} disabled={editBusy || Boolean(reviewEditResult.blockers.length)}>Accept changes</button></div>
              </details>
            {/if}
            {#if retainedEditResult}
              <section class="edit-retained"><p><strong>Isolated edit retained</strong><small>The worktree is preserved for explicit recovery after reload.</small></p><button type="button" onclick={() => recoverEdit(retainedEditResult!.editId, "discard")} disabled={editBusy}>Discard</button><button class="resume-edit" type="button" onclick={() => recoverEdit(retainedEditResult!.editId, "resume_review")} disabled={editBusy}>Resume review</button></section>
            {/if}
            {#if attachments.length}
              <div class="attachment-list">
                {#each attachments as attachment, index}
                  {#if isImageAttachment(attachment)}
                    <div class="image-draft"><img src={imageUrl(attachment)} alt="" /><span class="image-draft-copy"><strong>{attachment.name}</strong><small>{imageSize(attachment)}</small></span><button type="button" aria-label={`Remove ${attachment.name}`} onclick={() => removeAttachment(index)}>×</button></div>
                  {:else}
                    <span><code>{attachment.path}</code><button type="button" aria-label={`Remove ${attachment.path}`} onclick={() => removeAttachment(index)}>×</button></span>
                  {/if}
                {/each}
              </div>
            {/if}
            <div class="composer-stack">
              {#if mentionOpen}
                <section class="mention-menu" id="repository-mention-options" aria-label="Mention a repository file or folder">
                  <header><span class="mention-mark">@</span><div><strong>Repository context</strong><small>{mentionQuery ? `Matches for “${mentionQuery}”` : "Files and folders"}</small></div><kbd>esc</kbd></header>
                  <div class="mention-options" role="listbox" aria-label="Repository paths">
                    {#if repositoryIndexLoading && !repositoryEntries.length}
                      <div class="mention-state loading" aria-live="polite"><span></span><p><strong>Indexing repository…</strong><small>Nested files will appear as they are discovered.</small></p></div>
                    {:else if mentionResults.length}
                      {#each mentionResults as entry, index (entry.path)}
                        <button id={`repository-mention-${index}`} class:active={mentionSelection === index} type="button" role="option" aria-selected={mentionSelection === index} onmouseenter={() => mentionSelection = index} onclick={() => chooseMention(entry)}>
                          <span class="mention-icon" data-type={entry.type} aria-hidden="true">
                            {#if entry.type === "directory"}<svg viewBox="0 0 24 24"><path d="M3 6h7l2 2h9v10H3z"/></svg>{:else}<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5"/></svg>{/if}
                          </span>
                          <span class="mention-path"><strong>{entry.name}</strong><small>{entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "Repository root"}</small></span>
                          <span class="mention-kind">{entry.type === "directory" ? "Folder" : "File"}</span>
                        </button>
                      {/each}
                    {:else if repositoryIndexError && !repositoryEntries.length}
                      <div class="mention-state failure"><span>!</span><p><strong>Paths unavailable</strong><small>{repositoryIndexError}</small></p><button type="button" onclick={() => { repositoryIndexLoaded = false; void loadRepositoryIndex(); }}>Retry</button></div>
                    {:else}
                      <div class="mention-state empty"><span>∅</span><p><strong>No matching path</strong><small>Try part of a filename or folder path.</small></p></div>
                    {/if}
                  </div>
                  <footer><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Add context</span>{#if repositoryIndexLoading && repositoryEntries.length}<span class="indexing-dot">Indexing…</span>{/if}</footer>
                </section>
              {/if}
              <div class="composer-card" class:disabled={!providerReady || selectedSession.state === "closed"}>
                <textarea bind:this={composerElement} bind:value={composer} oninput={handleComposerInput} onkeydown={handleComposerKeydown} onkeyup={handleComposerCaret} onblur={handleComposerBlur} onclick={() => updateMentionFromComposer()} rows="2" maxlength="32000" aria-label="Chat message" aria-autocomplete="list" aria-controls={mentionOpen ? "repository-mention-options" : undefined} aria-activedescendant={mentionOpen && mentionResults.length ? `repository-mention-${mentionSelection}` : undefined} placeholder={selectedSession.state === "closed" ? "This conversation is archived" : providerReady ? chatMode === "edit" ? `Describe the change for ${selectedRunner?.name}…` : `Ask ${selectedRunner?.name} about ${repositoryName}…` : "Select an available provider and discovered model in repository settings"} disabled={!providerReady || selectedSession.state === "closed"}></textarea>
                <div class="composer-toolbar">
                  <form class="attachment-entry" onsubmit={(event) => { event.preventDefault(); addAttachment(); }}>
                    {#if chatMode === "edit"}
                      <label class="edit-access-select" data-mode={editAccessMode} title="Applies to Edit mode in every repository">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v5c0 4.6 2.8 8.1 7 10 4.2-1.9 7-5.4 7-10V6z"/><path d="m9.5 12 1.7 1.7 3.7-4"/></svg>
                        <select aria-label="Edit access mode" value={editAccessMode} onchange={changeEditAccessMode}>
                          <option value="ask_for_approval">Ask for approval</option>
                          <option value="full_access">Full Access</option>
                        </select>
                      </label>
                    {/if}
                    <button class="mention-trigger" type="button" aria-label="Mention repository file or folder" aria-expanded={mentionOpen} title="Mention file or folder" onclick={openMentionPicker}><strong>@</strong><span>Files & folders</span></button>
                    <input class="image-input" bind:this={imageInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onchange={chooseImages} />
                    <button class="image-trigger" type="button" aria-label="Attach images" title="Attach or paste images" onclick={() => imageInput?.click()} disabled={!providerReady || selectedSession.state !== "open"}>
                      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m5 18 5-5 3 3 2-2 4 4"/></svg><span>Images</span>
                    </button>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 12 5-5a3 3 0 0 1 4 4l-7 7a5 5 0 0 1-7-7l7-7"/></svg>
                    <input bind:value={attachmentDraft} aria-label="Repository-relative attachment path" placeholder="or paste a repository path" />
                    {#if attachmentDraft}<button type="submit">Add</button>{/if}
                  </form>
                  <div class="composer-actions">
                    <span>{composer.length.toLocaleString()} / 32,000</span>
                    {#if activeTurn}<button class="cancel-button" type="button" onclick={() => cancelTurn(activeTurn!.turnId)}><i></i>Stop</button>{:else if chatMode === "edit"}<button class="send-button" type="button" aria-label={editAccessMode === "ask_for_approval" ? "Review edit request" : "Start full-access edit"} onclick={prepareEdit} disabled={!composer.trim() || editBusy || Boolean(activeEdit)}><span>{editAccessMode === "ask_for_approval" ? "Review request" : "Start edit"}</span><kbd>↵</kbd></button>{:else}<button class="send-button" type="button" aria-label="Send message" onclick={sendMessage} disabled={!canSend}><span>Send</span><kbd>↵</kbd></button>{/if}
                  </div>
                </div>
              </div>
            </div>
            <p class="composer-hint"><span><i></i>{chatMode === "edit" ? editAccessMode === "ask_for_approval" ? "Approval before agent starts · isolated worktree" : "Full repository access · review before apply" : "Read-only repository access"}</span><span>Attach or paste images · Type @ for context · Enter to {chatMode === "edit" ? editAccessMode === "ask_for_approval" ? "review request" : "start edit" : "send"}</span></p>
          </footer>
        {:else}
          <section class="no-session">
            <div class="atlas-orbit" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
            <p>Repository agent chat</p><h3>Start an independent conversation</h3>
            <p>Chat with a discovered provider without selecting a workspace or canonical task.</p>
            <button type="button" onclick={createSession} disabled={!providerReady || creating}>{creating ? "Creating conversation…" : "New conversation"}</button>
            {#if !providerReady}<small>Choose an available CLI and model first.</small><button class="settings-link" type="button" onclick={onShowAgentConfiguration}>Show agent configuration</button>{/if}
          </section>
        {/if}
      </main>
    </div>
  </section>
</div>

<style>
  .chat-layer { position: fixed; z-index: 96; inset: 0 0 var(--chat-terminal-inset,0px) var(--sidebar-width); padding: 10px; background: color-mix(in srgb,var(--canvas) 82%,transparent); backdrop-filter: blur(12px); animation: chat-in .2s cubic-bezier(.2,.76,.2,1); }
  .chat-layer.inactive { display: none; }
  .chat-shell { display: grid; width: 100%; height: 100%; grid-template-rows: 64px minmax(0,1fr); overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); color: var(--text); box-shadow: 0 24px 80px rgba(16,22,19,.18); }
  .chat-header { display: grid; min-width: 0; grid-template-columns: 40px minmax(180px,1fr) minmax(160px,auto) auto auto auto 36px; align-items: center; gap: 8px; border-bottom: 1px solid var(--border); padding: 0 12px 0 16px; background: color-mix(in srgb,var(--surface) 96%,var(--brand-50)); -webkit-app-region: drag; }
  .chat-header button,.chat-header .provider-chip,.chat-header .read-only-chip { -webkit-app-region: no-drag; }.chat-mark { position: relative; width: 32px; height: 32px; border: 1px solid var(--brand-200); border-radius: 10px; background: var(--active-surface); }.chat-mark span { position: absolute; width: 7px; height: 7px; border: 1px solid var(--brand-500); background: var(--surface); transform: rotate(45deg); }.chat-mark span:nth-child(1) { top: 5px; left: 12px; }.chat-mark span:nth-child(2) { bottom: 5px; left: 5px; }.chat-mark span:nth-child(3) { right: 5px; bottom: 5px; background: var(--brand-500); }
  .chat-title { min-width: 0; }.chat-title p,.conversation-header p { margin: 0 0 2px; color: var(--active-text); font-size: 11px; font-weight: 800; letter-spacing: .09em; text-transform: uppercase; }.chat-title h2 { overflow: hidden; margin: 0; font-size: 16px; letter-spacing: -.015em; text-overflow: ellipsis; white-space: nowrap; }.chat-title h2 span { color: var(--text-subtle); font-weight: 560; }
  .provider-chip { display: flex; min-width: 0; align-items: center; gap: 8px; border: 1px solid var(--border); border-radius: var(--radius); padding: 6px 9px; background: var(--surface); color: var(--text); text-align: left; }.provider-chip:hover { border-color: var(--brand-300); background: var(--active-surface); }.provider-chip > span { width: 7px; height: 7px; flex: 0 0 7px; border-radius: 50%; background: var(--success-500); box-shadow: 0 0 0 3px color-mix(in srgb,var(--success-500) 14%,transparent); }.provider-chip.unavailable > span { background: var(--warning-500); }.provider-chip div { min-width: 0; }.provider-chip small,.provider-chip strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.provider-chip small { color: var(--text-subtle); font-size: 10px; text-transform: uppercase; }.provider-chip strong { margin-top: 1px; font-size: 12px; }
  .explorer-chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 10px; background: var(--surface); color: var(--text-muted); font-size: 12px; font-weight: 750; }.explorer-chip:hover,.explorer-chip.active { border-color: var(--brand-300); background: var(--active-surface); color: var(--active-text); }.explorer-chip svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.7; }
  .read-only-chip { display: flex; align-items: center; gap: 5px; border: 1px solid var(--border); border-radius: var(--radius-full); padding: 5px 8px; color: var(--text-muted); font-size: 11px; font-weight: 750; text-transform: uppercase; }.read-only-chip svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.8; }.close-chat { display: grid; width: 34px; height: 34px; place-items: center; border: 0; border-radius: var(--radius); background: transparent; color: var(--text-muted); font-size: 24px; }.close-chat:hover { background: var(--surface-soft); color: var(--text); }
  .chat-grid { display: grid; min-height: 0; grid-template-columns: 252px minmax(0,1fr); }.session-rail { display: grid; min-height: 0; grid-template-rows: 52px minmax(0,1fr) 44px; border-right: 1px solid var(--border); background: var(--surface-soft); }.session-rail-header { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); padding: 0 10px 0 13px; }.session-rail-header > div { display: flex; align-items: center; gap: 7px; }.session-rail-header span { color: var(--text-muted); font-size: 12px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }.session-rail-header strong { display: grid; min-width: 20px; height: 18px; place-items: center; border-radius: var(--radius-full); background: var(--surface); color: var(--text-subtle); font-size: 11px; }.session-rail-header > button { display: grid; width: 29px; height: 29px; place-items: center; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--active-text); font-size: 18px; }.session-rail-header > button:hover { border-color: var(--brand-300); background: var(--active-surface); }.session-rail-header > button:disabled { opacity: .45; }
  .session-list { min-height: 0; overflow: auto; padding: 7px; }.session-item { position: relative; min-height: 60px; overflow: hidden; border: 1px solid transparent; border-radius: var(--radius); }.session-item + .session-item { margin-top: 3px; }.session-item:hover { background: var(--surface); }.session-item.active { border-color: var(--brand-200); background: var(--surface); box-shadow: 0 2px 8px rgba(25,31,28,.05); }.session-item.closed { opacity: .68; }.session-select { display: grid; width: 100%; min-height: 60px; grid-template-columns: 9px minmax(0,1fr); align-items: center; gap: 7px; border: 0; padding: 8px 45px 8px 8px; background: transparent; color: var(--text); text-align: left; }.session-select > span:last-child { min-width: 0; }.session-select strong,.session-select small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.session-select strong { font-size: 13px; }.session-select small { margin-top: 4px; color: var(--text-subtle); font: 10px/1.3 "SFMono-Regular",Consolas,monospace; }.session-state { width: 7px; height: 7px; border-radius: 50%; background: var(--ink-300); }.session-state[data-state="open"] { background: var(--success-500); }.session-state[data-state="running"] { background: var(--brand-500); animation: signal 1.2s ease infinite; }.session-actions { position: absolute; top: 50%; right: 6px; display: flex; opacity: 0; transform: translateY(-50%); }.session-item:hover .session-actions,.session-item.active .session-actions { opacity: 1; }.session-actions button { display: grid; width: 23px; height: 25px; place-items: center; border: 0; border-radius: var(--radius-xs); background: transparent; color: var(--text-subtle); font-size: 13px; }.session-actions button:hover { background: var(--surface-soft); color: var(--text); }.rename-form { display: grid; min-height: 60px; grid-template-columns: minmax(0,1fr) auto; align-items: center; gap: 5px; padding: 7px; }.rename-form input { min-width: 0; border: 1px solid var(--brand-400); border-radius: var(--radius-sm); padding: 7px; background: var(--surface); color: var(--text); font-size: 12px; }.rename-form button { border: 0; border-radius: var(--radius-sm); padding: 7px; background: var(--brand-600); color: white; font-size: 11px; }.session-empty { padding: 28px 16px; text-align: center; }.session-empty strong { font-size: 13px; }.session-empty p { margin: 5px 0; color: var(--text-subtle); font-size: 12px; line-height: 1.5; }.session-skeleton { display: grid; grid-template-columns: 8px 1fr; gap: 8px; margin: 8px; }.session-skeleton span { width: 7px; height: 7px; margin-top: 3px; border-radius: 50%; background: var(--border); }.session-skeleton i { height: 34px; border-radius: var(--radius-sm); background: linear-gradient(90deg,var(--surface),var(--border-soft),var(--surface)); background-size: 200% 100%; animation: shimmer 1.3s linear infinite; }.session-rail-footer { display: flex; align-items: center; gap: 8px; border-top: 1px solid var(--border); padding: 0 13px; }.session-rail-footer > span { width: 7px; height: 7px; border-radius: 2px; background: var(--brand-500); transform: rotate(45deg); }.session-rail-footer p { margin: 0; }.session-rail-footer strong,.session-rail-footer small { display: block; }.session-rail-footer strong { font-size: 11px; }.session-rail-footer small { margin-top: 1px; color: var(--text-subtle); font-size: 10px; }
  .conversation { display: grid; min-width: 0; min-height: 0; grid-template-rows: 52px minmax(0,1fr) auto; background: color-mix(in srgb,var(--surface) 97%,var(--canvas)); }.conversation-header { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 18px; border-bottom: 1px solid var(--border); padding: 0 18px; background: var(--surface); }.conversation-header > div:first-child { min-width: 0; }.conversation-header h3 { overflow: hidden; margin: 0; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }.conversation-meta { display: flex; gap: 6px; }.conversation-meta span { border: 1px solid var(--border); border-radius: var(--radius-full); padding: 4px 7px; color: var(--text-subtle); font-size: 11px; }
  .conversation-controls { display: flex; min-width: 0; align-items: center; gap: 7px; }.mode-switch { display: flex; border: 1px solid var(--border); border-radius: var(--radius); padding: 2px; background: var(--surface-soft); }.mode-switch button { border: 0; border-radius: var(--radius-sm); padding: 4px 8px; background: transparent; color: var(--text-subtle); font-size: 11px; font-weight: 750; }.mode-switch button.active { background: var(--surface); color: var(--active-text); box-shadow: 0 1px 4px rgba(20,28,23,.1); }.task-handoff { border: 1px solid var(--border); border-radius: var(--radius); padding: 6px 8px; background: var(--surface); color: var(--text-muted); font-size: 11px; font-weight: 750; }.task-handoff:hover { border-color: var(--brand-300); color: var(--active-text); }.task-handoff:disabled { opacity: .45; }
  .transcript { min-height: 0; overflow: auto; overscroll-behavior: contain; }.transcript-column { width: min(820px,calc(100% - 40px)); margin: 0 auto; padding: 30px 0 42px; }.turn + .turn { margin-top: 30px; border-top: 1px solid var(--border-soft); padding-top: 30px; }.message { position: relative; }.message header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }.message header span { font-size: 12px; font-weight: 800; letter-spacing: .035em; }.message time { color: var(--text-subtle); font-size: 11px; }.user-message { max-width: 76%; margin-left: auto; border: 1px solid var(--brand-200); border-radius: 14px 14px 4px 14px; padding: 12px 14px; background: var(--active-surface); }.user-message header span { color: var(--active-text); }.user-message p { margin: 0; color: var(--text); font-size: 13px; line-height: 1.58; white-space: pre-wrap; word-break: break-word; }.message-attachments { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 10px; }.message-attachments code { border: 1px solid var(--brand-200); border-radius: var(--radius-full); padding: 4px 7px; background: var(--surface); color: var(--active-text); font-size: 11px; }.message-image { width: min(240px,100%); overflow: hidden; margin: 0; border: 1px solid var(--brand-200); border-radius: var(--radius); background: var(--surface); }.message-image img { display: block; width: 100%; max-height: 220px; object-fit: contain; background: var(--surface-soft); }.message-image figcaption { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px; }.message-image figcaption span { overflow: hidden; font-size: 10px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }.message-image figcaption small { flex: 0 0 auto; color: var(--text-subtle); font-size: 9px; }.retry-note { display: block; margin-top: 7px; color: var(--text-subtle); font-size: 11px; }.assistant-message { margin-top: 18px; }.assistant-message > header { border-bottom: 1px solid var(--border-soft); padding-bottom: 8px; }.assistant-message > header span { display: flex; align-items: center; gap: 7px; }.assistant-message > header span i { width: 8px; height: 8px; border-radius: 2px; background: var(--brand-500); transform: rotate(45deg); }.assistant-message > header div { display: flex; align-items: center; gap: 8px; }.assistant-message > header button { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 3px 6px; background: var(--surface); color: var(--text-subtle); font-size: 10px; }.turn-timeline { display: grid; gap: 14px; }.assistant-segment { min-width: 0; }.markdown-message { color: var(--text-muted); font-size: 13px; line-height: 1.72; }.markdown-message.streaming::after { display: inline-block; width: 6px; height: 13px; margin-left: 3px; background: var(--brand-500); content: ""; vertical-align: -2px; animation: blink .8s steps(2,end) infinite; }.markdown-message :global(p) { margin: 0 0 11px; }.assistant-segment :global(*:last-child) { margin-bottom: 0; }.markdown-message :global(h1),.markdown-message :global(h2),.markdown-message :global(h3) { margin: 18px 0 8px; color: var(--text); line-height: 1.35; }.markdown-message :global(h1) { font-size: 20px; }.markdown-message :global(h2) { font-size: 17px; }.markdown-message :global(h3) { font-size: 14px; }.markdown-message :global(ul),.markdown-message :global(ol) { padding-left: 21px; }.markdown-message :global(code) { border: 1px solid var(--border); border-radius: var(--radius-xs); padding: 1px 4px; background: var(--surface-soft); color: var(--text); font: 13px/1.55 "SFMono-Regular",Consolas,monospace; }.markdown-message :global(pre) { overflow: auto; border: 1px solid #303a35; border-radius: var(--radius); padding: 12px; background: #131a17; color: #c8d5cd; }.markdown-message :global(pre code) { border: 0; padding: 0; background: transparent; color: inherit; }.markdown-message :global(a) { color: var(--active-text); pointer-events: none; text-decoration: underline; }.markdown-message :global(img) { display: none; }.markdown-message :global(table) { width: 100%; border-collapse: collapse; }.markdown-message :global(th),.markdown-message :global(td) { border: 1px solid var(--border); padding: 6px 8px; text-align: left; }.markdown-message :global(.mermaid) { overflow: auto; }
  .timeline-activity { display: grid; min-width: 0; min-height: 34px; grid-template-columns: 22px minmax(0,1fr) 7px; align-items: center; gap: 9px; padding: 1px 4px; color: var(--text-subtle); }.timeline-activity-icon { display: grid; width: 22px; height: 22px; place-items: center; color: var(--text-subtle); }.timeline-activity-icon svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.45; }.timeline-activity[data-kind="reasoning"] .timeline-activity-icon { color: var(--warning-text); }.timeline-activity-copy { display: flex; min-width: 0; align-items: baseline; gap: 8px; }.timeline-activity-copy strong { overflow: hidden; color: var(--text-muted); font-size: 12px; font-weight: 560; line-height: 1.4; text-overflow: ellipsis; white-space: nowrap; }.timeline-activity-copy small { flex: 0 0 auto; color: var(--text-subtle); font: 9px/1.2 "SFMono-Regular",Consolas,monospace; letter-spacing: .04em; text-transform: uppercase; }.timeline-activity > i { width: 6px; height: 6px; border-radius: 50%; background: var(--success-500); }.timeline-activity[data-status="running"] > i { background: var(--brand-500); animation: signal 1.2s ease infinite; }.timeline-activity[data-status="failed"] > i { background: #c44242; }.quiet-pulse.inline { display: grid; min-height: 34px; grid-template-columns: 22px minmax(0,1fr); align-items: center; gap: 9px; padding: 1px 4px; }.quiet-pulse.inline > span { width: 17px; height: 17px; border: 1.5px solid var(--border); border-top-color: var(--brand-500); border-radius: 50%; animation: spin .9s linear infinite; }.quiet-pulse.inline p { margin: 0; }.quiet-pulse.inline strong,.quiet-pulse.inline small { display: inline; font-size: 11px; }.quiet-pulse.inline strong { color: var(--text-muted); }.quiet-pulse.inline small { margin-left: 6px; color: var(--text-subtle); }
  .turn-terminal { display: grid; grid-template-columns: 28px minmax(0,1fr) auto; align-items: center; gap: 9px; margin-top: 13px; border: 1px solid color-mix(in srgb,#c44242 35%,var(--border)); border-radius: var(--radius); padding: 9px; background: color-mix(in srgb,#c44242 7%,var(--surface)); }.turn-terminal[data-status="interrupted"] { border-color: color-mix(in srgb,var(--warning-500) 45%,var(--border)); background: var(--warning-surface); }.turn-terminal > span { display: grid; width: 26px; height: 26px; place-items: center; border-radius: var(--radius-sm); background: #c44242; color: white; font-weight: 850; }.turn-terminal[data-status="interrupted"] > span { background: var(--warning-500); }.turn-terminal p { margin: 0; }.turn-terminal strong,.turn-terminal small { display: block; }.turn-terminal strong { font-size: 12px; }.turn-terminal small { margin-top: 2px; color: var(--text-muted); font-size: 11px; }.turn-terminal button { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px 8px; background: var(--surface); color: var(--text); font-size: 11px; font-weight: 750; }
  .conversation-empty,.no-session { display: grid; justify-items: center; align-content: center; text-align: center; }.conversation-empty { min-height: 100%; padding: 28px; }.conversation-empty > p:first-of-type,.no-session > p:first-of-type { margin: 16px 0 3px; color: var(--active-text); font-size: 11px; font-weight: 800; letter-spacing: .09em; text-transform: uppercase; }.conversation-empty h3,.no-session h3 { margin: 0; font-size: 21px; letter-spacing: -.02em; }.conversation-empty > p:nth-of-type(2),.no-session > p:nth-of-type(2) { max-width: 490px; margin: 8px 0 18px; color: var(--text-muted); font-size: 13px; line-height: 1.6; }.atlas-orbit { position: relative; width: 54px; height: 54px; border: 1px solid var(--brand-200); border-radius: 50%; background: var(--active-surface); }.atlas-orbit::before,.atlas-orbit::after { position: absolute; inset: 13px; border: 1px solid var(--brand-300); border-radius: 50%; content: ""; }.atlas-orbit::after { inset: 25px; border: 0; background: var(--brand-600); }.atlas-orbit span { position: absolute; width: 6px; height: 6px; border-radius: 2px; background: var(--brand-500); transform: rotate(45deg); }.atlas-orbit span:nth-child(1) { top: 5px; left: 24px; }.atlas-orbit span:nth-child(2) { top: 24px; right: 5px; }.atlas-orbit span:nth-child(3) { bottom: 5px; left: 24px; }.atlas-orbit span:nth-child(4) { top: 24px; left: 5px; }.suggestions { display: grid; width: min(520px,100%); gap: 6px; }.suggestions button { display: flex; min-height: 38px; align-items: center; justify-content: space-between; border: 1px solid var(--border); border-radius: var(--radius); padding: 0 11px; background: var(--surface); color: var(--text-muted); font-size: 12px; text-align: left; }.suggestions button:hover { border-color: var(--brand-200); color: var(--active-text); transform: translateX(2px); }.suggestions span { color: var(--brand-500); }
  .composer-zone { position: relative; border-top: 1px solid var(--border); padding: 10px 18px 8px; background: color-mix(in srgb,var(--surface) 94%,transparent); backdrop-filter: blur(12px); }
  .composer-stack { position: relative; width: min(850px,100%); margin: 0 auto; }
  .composer-card { width: 100%; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: 0 4px 18px rgba(25,31,28,.07); }.composer-card:focus-within { border-color: var(--brand-400); box-shadow: 0 0 0 3px color-mix(in srgb,var(--brand-400) 14%,transparent); }.composer-card.disabled { opacity: .65; }.composer-card textarea { display: block; width: 100%; min-height: 58px; max-height: 180px; resize: vertical; border: 0; padding: 12px 14px 7px; outline: 0; background: transparent; color: var(--text); font: 14px/1.55 Inter,ui-sans-serif,system-ui,sans-serif; }.composer-card textarea::placeholder { color: var(--text-subtle); }
  .mention-menu { position: absolute; z-index: 5; right: 0; bottom: calc(100% + 7px); left: 0; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: 0 18px 48px rgba(16,22,19,.2); animation: mention-in .14s cubic-bezier(.2,.76,.2,1); }.mention-menu > header { display: grid; min-height: 48px; grid-template-columns: 30px minmax(0,1fr) auto; align-items: center; gap: 9px; border-bottom: 1px solid var(--border); padding: 7px 10px; background: var(--surface-soft); }.mention-mark { display: grid; width: 28px; height: 28px; place-items: center; border: 1px solid var(--brand-300); border-radius: var(--radius-sm); background: var(--active-surface); color: var(--active-text); font: 800 15px/1 "SFMono-Regular",Consolas,monospace; }.mention-menu > header div { min-width: 0; }.mention-menu > header strong,.mention-menu > header small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.mention-menu > header strong { font-size: 11px; }.mention-menu > header small { margin-top: 2px; color: var(--text-subtle); font-size: 10px; }.mention-menu > header > kbd { border: 1px solid var(--border); border-radius: var(--radius-xs); padding: 3px 5px; background: var(--surface); color: var(--text-subtle); font: 9px/1 "SFMono-Regular",Consolas,monospace; }.mention-options { max-height: min(330px,40vh); overflow: auto; padding: 5px; }.mention-options > button { display: grid; width: 100%; min-height: 45px; grid-template-columns: 30px minmax(0,1fr) auto; align-items: center; gap: 9px; border: 1px solid transparent; border-radius: var(--radius-sm); padding: 5px 8px; background: transparent; color: var(--text); text-align: left; }.mention-options > button:hover,.mention-options > button.active { border-color: var(--brand-200); background: var(--active-surface); }.mention-icon { display: grid; width: 28px; height: 28px; place-items: center; border: 1px solid var(--border); border-radius: var(--radius-xs); background: var(--surface-soft); color: var(--text-muted); }.mention-options > button.active .mention-icon { border-color: var(--brand-300); background: var(--surface); color: var(--active-text); }.mention-icon svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.7; }.mention-icon[data-type="directory"] svg { fill: color-mix(in srgb,var(--brand-400) 14%,transparent); }.mention-path { min-width: 0; }.mention-path strong,.mention-path small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.mention-path strong { font: 650 11px/1.35 "SFMono-Regular",Consolas,monospace; }.mention-path small { margin-top: 2px; color: var(--text-subtle); font-size: 9px; }.mention-kind { color: var(--text-subtle); font-size: 9px; font-weight: 750; text-transform: uppercase; }.mention-menu > footer { display: flex; min-height: 30px; align-items: center; gap: 14px; border-top: 1px solid var(--border-soft); padding: 4px 10px; background: var(--surface-soft); color: var(--text-subtle); font-size: 9px; }.mention-menu > footer span { display: flex; align-items: center; gap: 4px; }.mention-menu > footer kbd { min-width: 17px; border: 1px solid var(--border); border-radius: 3px; padding: 2px 3px; background: var(--surface); color: var(--text-muted); font: 9px/1 "SFMono-Regular",Consolas,monospace; text-align: center; }.mention-menu > footer .indexing-dot { margin-left: auto; color: var(--active-text); }.mention-state { display: grid; min-height: 92px; grid-template-columns: 28px minmax(0,1fr) auto; place-content: center stretch; align-items: center; gap: 10px; padding: 14px; color: var(--text-muted); }.mention-state > span { display: grid; width: 27px; height: 27px; place-items: center; border-radius: 50%; background: var(--surface-soft); color: var(--text-subtle); font-size: 11px; font-weight: 800; }.mention-state.loading > span { border: 2px solid var(--border); border-top-color: var(--brand-500); background: transparent; animation: spin .8s linear infinite; }.mention-state p { margin: 0; }.mention-state strong,.mention-state small { display: block; }.mention-state strong { color: var(--text); font-size: 11px; }.mention-state small { margin-top: 3px; color: var(--text-subtle); font-size: 10px; }.mention-state > button { border: 1px solid var(--border); border-radius: var(--radius-xs); padding: 5px 8px; background: var(--surface-soft); color: var(--text); font-size: 10px; }
  .composer-toolbar { display: flex; min-height: 38px; align-items: center; justify-content: space-between; gap: 10px; border-top: 1px solid var(--border-soft); padding: 4px 5px 4px 7px; }.attachment-entry { display: flex; min-width: 0; flex: 1; align-items: center; gap: 5px; }.attachment-entry svg { width: 14px; height: 14px; flex: 0 0 14px; fill: none; stroke: var(--text-subtle); stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.7; }.attachment-entry input { width: min(210px,100%); border: 0; outline: 0; background: transparent; color: var(--text-muted); font: 11px/1.4 "SFMono-Regular",Consolas,monospace; }.attachment-entry input.image-input { display: none; }.attachment-entry button { border: 1px solid var(--border); border-radius: var(--radius-xs); padding: 3px 6px; background: var(--surface-soft); color: var(--text); font-size: 10px; }.attachment-entry .mention-trigger,.attachment-entry .image-trigger { display: inline-flex; min-height: 27px; flex: 0 0 auto; align-items: center; gap: 6px; border-color: var(--brand-200); padding: 0 8px; background: var(--active-surface); color: var(--active-text); font-weight: 750; }.mention-trigger strong { font: 850 13px/1 "SFMono-Regular",Consolas,monospace; }.attachment-entry .mention-trigger:hover,.attachment-entry .image-trigger:hover { border-color: var(--brand-400); background: color-mix(in srgb,var(--active-surface) 80%,var(--brand-100)); }.attachment-entry .image-trigger:disabled { cursor: default; opacity: .42; }.attachment-entry .image-trigger svg { stroke: currentColor; }.composer-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; }.composer-actions > span { color: var(--text-subtle); font-size: 10px; }.send-button,.cancel-button { display: flex; min-height: 29px; align-items: center; gap: 8px; border: 0; border-radius: var(--radius-sm); padding: 0 9px; background: var(--brand-600); color: white; font-size: 11px; font-weight: 800; }.send-button kbd { border-left: 1px solid rgba(255,255,255,.25); padding-left: 7px; font: inherit; }.send-button:disabled { opacity: .38; }.cancel-button { background: #b94040; }.cancel-button i { width: 7px; height: 7px; background: white; }.composer-hint { display: flex; width: min(850px,100%); justify-content: space-between; margin: 5px auto 0; color: var(--text-subtle); font-size: 10px; }.composer-hint span { display: flex; align-items: center; gap: 5px; }.composer-hint i { width: 5px; height: 5px; border-radius: 50%; background: var(--success-500); }.attachment-list { display: flex; width: min(850px,100%); flex-wrap: wrap; gap: 6px; margin: 0 auto 6px; }.attachment-list > span { display: flex; align-items: center; gap: 5px; border: 1px solid var(--brand-200); border-radius: var(--radius-full); padding: 4px 5px 4px 8px; background: var(--active-surface); }.attachment-list code { color: var(--active-text); font-size: 10px; }.attachment-list button { display: grid; width: 16px; height: 16px; place-items: center; border: 0; border-radius: 50%; background: var(--surface); color: var(--text-muted); font-size: 13px; }.image-draft { position: relative; display: grid; width: 190px; height: 62px; grid-template-columns: 62px minmax(0,1fr) 20px; align-items: center; gap: 7px; overflow: hidden; margin: 0; border: 1px solid var(--brand-200); border-radius: var(--radius); padding-right: 5px; background: var(--active-surface); }.image-draft img { width: 62px; height: 62px; object-fit: cover; background: var(--surface-soft); }.image-draft-copy { min-width: 0; }.image-draft strong,.image-draft small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.image-draft strong { color: var(--text); font-size: 10px; }.image-draft small { margin-top: 3px; color: var(--text-subtle); font-size: 9px; }.image-draft button { align-self: start; margin-top: 5px; }.chat-error { display: grid; width: min(850px,100%); grid-template-columns: 20px minmax(0,1fr) 20px; align-items: center; gap: 7px; margin: 0 auto 7px; border: 1px solid color-mix(in srgb,#c44242 40%,var(--border)); border-radius: var(--radius); padding: 6px; background: color-mix(in srgb,#c44242 7%,var(--surface)); }.chat-error > span { display: grid; width: 20px; height: 20px; place-items: center; border-radius: var(--radius-xs); background: #c44242; color: white; font-size: 11px; font-weight: 850; }.chat-error p { overflow: hidden; margin: 0; color: var(--text-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.chat-error button { border: 0; background: transparent; color: var(--text-muted); font-size: 16px; }
  .edit-access-select { display: inline-flex; min-height: 27px; flex: 0 0 auto; align-items: center; gap: 4px; border: 1px solid var(--brand-300); border-radius: var(--radius-xs); padding: 0 5px 0 7px; background: var(--active-surface); color: var(--active-text); }.edit-access-select[data-mode="full_access"] { border-color: color-mix(in srgb,var(--warning-500) 58%,var(--border)); background: var(--warning-surface); color: var(--warning-text); }.edit-access-select svg { stroke: currentColor; }.edit-access-select select { max-width: 132px; border: 0; outline: 0; background: transparent; color: inherit; font: 750 10px/1.2 Inter,ui-sans-serif,system-ui,sans-serif; cursor: pointer; }.edit-confirmation,.edit-review,.edit-running { width: min(850px,100%); margin: 0 auto 8px; border: 1px solid var(--brand-300); border-radius: var(--radius); padding: 10px; background: var(--active-surface); }.edit-confirmation header { display: flex; align-items: center; justify-content: space-between; }.edit-confirmation header span { color: var(--active-text); font-size: 10px; font-weight: 850; letter-spacing: .08em; text-transform: uppercase; }.edit-confirmation header strong { font: 11px/1.2 "SFMono-Regular",Consolas,monospace; }.edit-confirmation dl { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin: 9px 0; }.edit-confirmation dl div { min-width: 0; }.edit-confirmation dt { color: var(--text-subtle); font-size: 10px; text-transform: uppercase; }.edit-confirmation dd { overflow: hidden; margin: 2px 0 0; color: var(--text); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.edit-confirmation p { margin: 7px 0; color: var(--text-muted); font-size: 11px; }.edit-confirmation > div:last-child,.review-actions { display: flex; justify-content: flex-end; gap: 6px; }.edit-confirmation button,.review-actions button { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px 9px; background: var(--surface); color: var(--text); font-size: 11px; font-weight: 750; }.edit-confirmation .confirm-edit,.review-actions .accept-edit { border-color: var(--brand-600); background: var(--brand-600); color: white; }.edit-running { display: grid; grid-template-columns: 20px minmax(0,1fr) auto; align-items: center; gap: 9px; }.edit-running > span { width: 18px; height: 18px; border: 2px solid var(--border); border-top-color: var(--brand-600); border-radius: 50%; animation: spin .8s linear infinite; }.edit-running p { margin: 0; }.edit-running strong,.edit-running small { display: block; }.edit-running strong { font-size: 11px; }.edit-running small { margin-top: 2px; color: var(--text-subtle); font-size: 10px; }.edit-running button { border: 0; border-radius: var(--radius-sm); padding: 6px 8px; background: #b94040; color: white; font-size: 10px; }.edit-review { background: var(--surface); }.edit-review summary { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; cursor: pointer; list-style: none; }.edit-review summary span { color: var(--warning-text); font-size: 10px; font-weight: 850; text-transform: uppercase; }.edit-review summary strong { font-size: 11px; }.edit-review summary small { color: var(--text-subtle); font-size: 10px; }.edit-review > p { margin: 9px 0; color: var(--text-muted); font-size: 11px; }.edit-review ul { display: grid; gap: 3px; margin: 7px 0; padding: 0; list-style: none; }.edit-review li { display: flex; justify-content: space-between; gap: 8px; border-bottom: 1px solid var(--border-soft); padding: 4px; font-size: 10px; }.edit-review li code { color: var(--text); }.edit-review li span { color: var(--text-subtle); text-transform: uppercase; }.edit-review pre { max-height: 220px; overflow: auto; border-radius: var(--radius-sm); padding: 9px; background: #121916; color: #b9c6be; font: 10px/1.5 "SFMono-Regular",Consolas,monospace; white-space: pre; }.edit-blockers { display: grid; gap: 3px; margin: 6px 0; color: #b94040; font-size: 10px; }
  .no-session { min-height: 100%; grid-row: 1 / -1; padding: 30px; }.no-session > button { min-height: 38px; border: 1px solid var(--brand-600); border-radius: var(--radius); padding: 0 13px; background: var(--brand-600); color: white; font-size: 12px; font-weight: 800; }.no-session > button:disabled { opacity: .45; }.no-session > small { margin-top: 8px; color: var(--warning-text); font-size: 11px; }.no-session > .settings-link { min-height: 30px; margin-top: 7px; border-color: var(--border); background: var(--surface); color: var(--active-text); }
  .edit-retained { display: flex; width: min(850px,100%); align-items: center; gap: 7px; margin: 0 auto 8px; border: 1px solid var(--warning-500); border-radius: var(--radius); padding: 8px 9px; background: var(--warning-surface); }.edit-retained p { min-width: 0; flex: 1; margin: 0; }.edit-retained strong,.edit-retained small { display: block; }.edit-retained strong { font-size: 11px; }.edit-retained small { margin-top: 2px; color: var(--text-muted); font-size: 10px; }.edit-retained button { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px 8px; background: var(--surface); color: var(--text); font-size: 10px; font-weight: 750; }.edit-retained .resume-edit { border-color: var(--brand-600); background: var(--brand-600); color: white; }
  .edit-verification { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; margin: 7px 0; }.edit-verification > span { border-left: 3px solid var(--success-500); border-radius: var(--radius-xs); padding: 5px 7px; background: var(--surface-soft); }.edit-verification > span[data-status="failed"] { border-left-color: #c44242; }.edit-verification strong,.edit-verification small { display: block; }.edit-verification strong { font-size: 10px; }.edit-verification small { margin-top: 2px; color: var(--text-subtle); font-size: 10px; }
  .session-actions:focus-within { opacity: 1; }

  /* Reading-first chat palette: neutral surfaces and primary contrast for long-form content. */
  .chat-layer {
    --chat-canvas: color-mix(in srgb,var(--canvas) 78%,var(--surface));
    --chat-sidebar: color-mix(in srgb,var(--canvas) 88%,var(--surface));
    --chat-user-surface: color-mix(in srgb,var(--surface) 72%,var(--active-surface));
    --chat-user-border: color-mix(in srgb,var(--border) 82%,var(--active-text));
    --chat-reading-text: color-mix(in srgb,var(--text) 92%,var(--text-muted));
    --chat-code-background: #17191d;
    --chat-code-border: #363941;
    --chat-code-text: #eceef2;
    background: color-mix(in srgb,var(--canvas) 90%,transparent);
    backdrop-filter: blur(8px);
  }
  .chat-shell,.conversation,.transcript { background: var(--chat-canvas); }
  .chat-header,.conversation-header { background: var(--surface); }
  .session-rail { background: var(--chat-sidebar); }
  .composer-zone { background: var(--chat-canvas); backdrop-filter: none; }
  .composer-card { background: var(--surface); box-shadow: 0 4px 18px color-mix(in srgb,var(--text) 7%,transparent); }
  .composer-card textarea { color: var(--text); font-size: 14px; line-height: 1.5; }
  .composer-card textarea::placeholder { color: var(--text-subtle); opacity: .9; }
  .user-message {
    border-color: var(--chat-user-border);
    background: var(--chat-user-surface);
    box-shadow: 0 1px 2px color-mix(in srgb,var(--text) 6%,transparent);
  }
  .user-message header span { color: var(--text-muted); }
  .user-message p { color: var(--text); font-size: 15px; line-height: 1.62; }
  .assistant-message { color: var(--chat-reading-text); }
  .markdown-message { color: var(--chat-reading-text); font-size: 15px; line-height: 1.67; }
  .markdown-message :global(p) { margin-bottom: 14px; }
  .markdown-message :global(ul),.markdown-message :global(ol) { margin: 10px 0 14px; }
  .markdown-message :global(li + li) { margin-top: 4px; }
  .markdown-message :global(h1),.markdown-message :global(h2),.markdown-message :global(h3) { color: var(--text); line-height: 1.28; }
  .markdown-message :global(h1) { font-size: 22px; }
  .markdown-message :global(h2) { font-size: 19px; }
  .markdown-message :global(h3) { font-size: 16px; }
  .markdown-message :global(code) { font-size: 13px; line-height: 1.55; }
  .markdown-message :global(pre) { border-color: var(--chat-code-border); background: var(--chat-code-background); color: var(--chat-code-text); }
  .markdown-message :global(pre code) { font-size: 13px; line-height: 1.65; }
  .markdown-message :global(blockquote) { margin: 14px 0; border-left: 3px solid var(--border); padding: 2px 0 2px 14px; color: var(--text-muted); }
  .markdown-message :global(th),.markdown-message :global(td) { font-size: 14px; line-height: 1.55; }
  .markdown-message :global(th) { background: var(--surface-soft); color: var(--text); }
  .markdown-message :global(.rendered-link) { color: var(--active-text); text-decoration: underline; text-underline-offset: 2px; }.markdown-message :global(.rendered-image) { color: var(--text-subtle); font-style: italic; }
  @keyframes chat-in { from { opacity: .4; transform: translateY(7px) scale(.997); } } @keyframes mention-in { from { opacity: 0; transform: translateY(6px) scale(.99); } } @keyframes signal { 50% { opacity: .3; box-shadow: 0 0 0 5px color-mix(in srgb,var(--brand-500) 12%,transparent); } } @keyframes spin { to { transform: rotate(360deg); } } @keyframes blink { 50% { opacity: .15; } } @keyframes shimmer { to { background-position: -200% 0; } }
  @media (max-width: 1080px) { .read-only-chip { display: none; }.chat-header { grid-template-columns: 40px minmax(170px,1fr) minmax(150px,auto) auto 36px; } }
  @media (max-width: 980px) { .chat-grid { grid-template-columns: 210px minmax(0,1fr); }.transcript-column { width: calc(100% - 28px); }.provider-chip { max-width: 190px; } }
  @media (max-width: 767.98px) { .chat-layer { inset: 0 0 var(--chat-terminal-inset,0px); padding: 0; }.chat-shell { border: 0; border-radius: 0; }.chat-grid { grid-template-columns: 160px minmax(0,1fr); }.session-select { padding-right: 8px; }.session-actions { display: none; }.provider-chip,.read-only-chip { display: none; }.chat-header { grid-template-columns: 40px minmax(0,1fr) 34px 34px 36px; }.explorer-chip { width: 34px; padding: 0; justify-content: center; font-size: 0; }.explorer-chip svg { width: 16px; height: 16px; }.conversation-meta { display: none; }.user-message { max-width: 90%; }.composer-zone { padding-inline: 10px; } }
  @media (max-width: 560px) { .chat-grid { display: block; }.session-rail { display: none; }.conversation { height: 100%; }.chat-title h2 span { display: none; }.transcript-column { width: calc(100% - 20px); padding-top: 18px; }.composer-hint span:last-child,.composer-actions > span,.attachment-entry > svg,.attachment-entry input { display: none; }.attachment-entry .mention-trigger span,.attachment-entry .image-trigger span { display: none; }.timeline-activity-copy small { display: none; }.mention-options { max-height: 260px; }.mention-kind { display: none; } }
  @media (prefers-reduced-motion: reduce) { .chat-layer,.mention-menu,.session-state,.timeline-activity > i,.quiet-pulse > span,.markdown-message.streaming::after { animation: none; } }
</style>
