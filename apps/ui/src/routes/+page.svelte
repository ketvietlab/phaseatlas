<script lang="ts">
  import { onMount, tick } from "svelte";
  import RepositoryWorkbench from "$lib/RepositoryWorkbench.svelte";
  import RepositoryChatWorkspace from "$lib/RepositoryChatWorkspace.svelte";
  import TerminalPanel from "$lib/TerminalPanel.svelte";
  import ProviderPicker from "$lib/ProviderPicker.svelte";
  import TaskConversation from "$lib/TaskConversation.svelte";
  import ModelMarkdown from "$lib/ModelMarkdown.svelte";
  import TaskContentPanel from "$lib/TaskContentPanel.svelte";
  import TaskMap from "$lib/TaskMap.svelte";
  import type {
    AgentResultReview,
    AgentRunAction,
    AgentRunActionAvailability,
    AgentRunSummary,
    CanonicalTask,
    PersistedRunEvent,
    PlanningProposalSet,
    PlanningStatus,
    PlanningTarget,
    RepositorySummary,
    RunnerDescriptor,
    TaskKind,
    TaskPriority,
    TaskSnapshot,
    TaskContentEvent,
    TaskContentRunStatus,
    WorkspaceSummary,
  } from "@phaseatlas/contracts";

  const TASK_KIND_OPTIONS: TaskKind[] = ["code", "docs", "research", "review", "operations"];
  const TASK_PRIORITY_OPTIONS: TaskPriority[] = ["critical", "high", "normal", "low"];
  const TASK_VIEW_STORAGE_KEY = "phaseatlas.task-view";
  const PROVIDER_SETTINGS_STORAGE_KEY = "phaseatlas.repository-provider-settings.v1";
  const SELECTED_AGENT_RUN_STORAGE_KEY = "phaseatlas.selected-agent-run.v1";
  const TERMINAL_HEIGHT_STORAGE_KEY = "phaseatlas.terminal-height.v1";
  const LEGACY_WORKBENCH_STATE_STORAGE_KEY = "phaseatlas.workbench-state.v1";
  const WORKBENCH_STATE_STORAGE_KEY = "phaseatlas.workbench-state.v2";

  type RepositoryProviderSettings = Record<string, {
    runnerId: string;
    modelId: string;
    reasoningEffort?: string;
  }>;
  type PersistedWorkbenchSurfaceState = {
    chatOpen: boolean;
    editorOpen: boolean;
    terminalOpen: boolean;
    terminalMaximized: boolean;
  };
  type PersistedWorkbenchState = {
    selectedCheckoutId: string;
    repositories: Record<string, PersistedWorkbenchSurfaceState>;
  };
  type CommandCard = {
    commandId: string;
    command: string;
    outputCharacters: number;
    exitCode?: number;
    sequence: number;
  };
  type CommandOutputState = {
    text: string;
    offset: number;
    nextOffset: number;
    totalCharacters: number;
    hasMore: boolean;
    loading: boolean;
    error: string;
  };

  let repositories: RepositorySummary[] = [];
  let workspaces: WorkspaceSummary[] = [];
  let runners: RunnerDescriptor[] = [];
  let taskSnapshot: TaskSnapshot | null = null;
  let selectedCheckoutId = "";
  let selectedWorkspaceSlug = "";
  let selectedTaskKey = "";
  let taskView: "list" | "map" = "map";
  let platform = "desktop";
  let theme = "light";
  let loading = true;
  let repositoryLoading = false;
  let repositoryLoadRequest = 0;
  let opening = false;
  let refreshing = false;
  let menuOpen = false;
  let errorMessage = "";
  let refreshTimer = 0;
  let plannerOpen = false;
  let plannerRequest = "";
  let plannerRunnerId = "";
  let plannerModel = "";
  let plannerReasoningEffort = "";
  let planningRunId = "";
  let planningStatus: PlanningStatus | "idle" = "idle";
  let planningLog = "";
  let planningStartedAt = 0;
  let planningEndedAt = 0;
  let planningLastActivityAt = 0;
  let planningClock = Date.now();
  let planningEventCount = 0;
  let streamExpanded = true;
  let streamAutofollow = true;
  let planningViewport: HTMLDivElement;
  let proposals: PlanningProposalSet | null = null;
  let plannerMode: PlanningTarget["type"] = "workspace";
  let plannerError = "";
  let publishing = false;
  let published = false;
  let editorOpen = false;
  let editorInitialPath = "";
  let contentPanelTaskKey = "";
  let contentRuns: Record<string, { status: TaskContentRunStatus; taskKeys: string[] }> = {};
  let contentTaskStatuses: Record<string, TaskContentRunStatus> = {};
  let contentTaskRunIds: Record<string, string> = {};
  let contentLogs: Record<string, string> = {};
  let contentFailures: Record<string, string> = {};
  let openEditorAfterTask: Record<string, boolean> = {};
  let executionOpen = false;
  const PIPELINE_ACTIONS: AgentRunAction[] = ["analyze", "plan", "implement", "review"];
  let openedFilePath = "";
  let openedFileContent = "";
  let openedFileError = "";
  let openedFileLoading = false;
  let openedFileRequest = 0;
  let openedFileMode: "preview" | "source" = "preview";
  let executionActions: AgentRunActionAvailability[] = [];
  let executionActionsLoading = false;
  let executionError = "";
  let executionNotice = "";
  let executionStartingAction: AgentRunAction | "" = "";
  let executionConfirmAction: AgentRunActionAvailability | null = null;
  let executionScopeConfirmed = false;
  let agentRuns: AgentRunSummary[] = [];
  let selectedAgentRunId = "";
  let agentEvents: Record<string, PersistedRunEvent[]> = {};
  let agentEventCursors: Record<string, number> = {};
  let agentResultReviews: Record<string, AgentResultReview> = {};
  let expandedCommandKeys = new Set<string>();
  let commandOutputs: Record<string, CommandOutputState> = {};
  let cancellingAgentRunId = "";
  let recoveringAgentRunId = "";
  const reconcilingAgentRuns = new Set<string>();
  let executionPanelElement: HTMLElement;
  let executionConfirmElement: HTMLElement;
  let agentConfigurationElement: HTMLElement;
  let executionReturnFocus: HTMLElement | null = null;
  let executionActionRequest = 0;
  let agentRunListRequest = 0;
  let terminalOpen = false;
  let terminalMaximized = false;
  let terminalHeight = 300;
  let terminalPanel: { focus(): void; hasFocus(): boolean } | undefined;
  let repositoryWorkbench: { closeActiveSurface(): void; focusActiveEditor(): void } | undefined;
  let taskContentPanel: { closeActiveSurface(): void } | undefined;
  let chatOpen = false;
  let workbenchStateReady = false;

  $: selectedRepository = repositories.find(
    (repository) => repository.checkoutId === selectedCheckoutId,
  );
  $: selectedWorkspace = workspaces.find((workspace) => workspace.slug === selectedWorkspaceSlug);
  $: workspaceTasks = (taskSnapshot?.tasks ?? []).filter(
    (task) => task.key.workspaceSlug === selectedWorkspaceSlug,
  );
  $: selectedTask = workspaceTasks.find((task) => canonicalTaskKey(task) === selectedTaskKey) ?? workspaceTasks[0];
  $: contentPanelTask = (taskSnapshot?.tasks ?? []).find((task) => canonicalTaskKey(task) === contentPanelTaskKey) ?? null;
  $: missingContentTasks = workspaceTasks.filter((task) => !task.content);
  $: activeContentTaskKeys = new Set(Object.entries(contentTaskStatuses)
    .filter(([, status]) => status === "starting" || status === "running")
    .map(([taskKey]) => taskKey));
  $: availableContentTasks = missingContentTasks.filter((task) => !activeContentTaskKeys.has(canonicalTaskKey(task)));
  $: availableRunners = runners.filter((runner) => runner.available);
  $: selectedRunner = runners.find((runner) => runner.id === plannerRunnerId);
  $: selectedModels = selectedRunner?.models ?? [];
  $: selectedProviderModel = selectedModels.find((model) => model.id === plannerModel);
  $: selectedReasoningEfforts = selectedProviderModel?.reasoningEfforts ?? [];
  $: reasoningEffortSupported = selectedReasoningEfforts.length > 0;
  // One ordered pipeline per task. A stage counts as done only when a completed
  // run exists for this exact task revision — an older revision is a stale claim,
  // not progress. The entry point is the first stage that is not yet done.
  $: openedFileIsMarkdown = /\.mdx?$/i.test(openedFilePath);
  $: pipelineRuns = selectedTask
    ? agentRuns.filter((run) => run.taskKey === canonicalTaskKey(selectedTask))
    : [];
  $: pipelineDraft = PIPELINE_ACTIONS.map((action) => {
    const availability = executionActions.find((candidate) => candidate.action === action)
      ?? { action, sandbox: action === "implement" ? "workspace-write" as const : "read-only" as const, available: false, blockingReasons: [] };
    const runs = pipelineRuns.filter((run) => run.action === action);
    const active = runs.some((run) => run.status === "starting" || run.status === "running");
    const done = runs.some((run) => run.status === "completed" && run.taskRevision === selectedTask?.revision);
    const stale = !done && runs.some((run) => run.status === "completed");
    const state = active ? "running" : done ? "done" : stale ? "stale" : availability.available ? "ready" : "blocked";
    return {
      action,
      availability,
      state,
      stateLabel: active
        ? "Running"
        : done
          ? "Completed"
          : stale
            ? "Superseded by a task edit"
            : availability.available
              ? availability.sandbox === "workspace-write" ? "Ready · isolated worktree" : "Ready · read-only"
              : availability.blockingReasons[0] ?? "Not available",
      isEntry: false,
    };
  });
  // A superseded stage still needs redoing, so it is a valid entry. While a stage
  // is running there is no entry at all — pointing further down the pipeline would
  // invite the user to start the next stage without its input.
  $: entryStageIndex = pipelineDraft.some((stage) => stage.state === "running")
    ? -1
    : pipelineDraft.findIndex((stage) => stage.state === "ready" || stage.state === "stale");
  $: pipelineStages = pipelineDraft.map((stage, index) => ({ ...stage, isEntry: index === entryStageIndex }));
  $: pipelineBlocker = entryStageIndex < 0
    ? pipelineStages.find((stage) => stage.state === "blocked")?.availability.blockingReasons[0] ?? ""
    : "";
  $: providerSelectionReady = Boolean(
    selectedRunner?.available && selectedProviderModel &&
    (!plannerReasoningEffort || selectedReasoningEfforts.includes(plannerReasoningEffort)),
  );
  $: planningActive = planningStatus === "starting" || planningStatus === "running";
  $: normalizedPlanningLog = normalizePlanningLog(planningLog);
  $: allPlanningLines = normalizedPlanningLog ? normalizedPlanningLog.split("\n") : [];
  $: visiblePlanningLines = allPlanningLines.slice(-180).map((text, index) => ({
    number: Math.max(allPlanningLines.length - 179, 1) + index,
    text,
    kind: streamLineKind(text),
  }));
  $: hiddenPlanningLineCount = Math.max(allPlanningLines.length - visiblePlanningLines.length, 0);
  $: planningElapsedMs = planningStartedAt
    ? Math.max((planningEndedAt || planningClock) - planningStartedAt, 0)
    : 0;
  $: planningSilenceMs = planningActive && planningLastActivityAt
    ? Math.max(planningClock - planningLastActivityAt, 0)
    : 0;
  $: selectedAgentRun = agentRuns.find((run) => run.runId === selectedAgentRunId) ?? null;
  $: selectedAgentEvents = selectedAgentRunId ? agentEvents[selectedAgentRunId] ?? [] : [];
  $: selectedAgentReview = selectedAgentRunId ? agentResultReviews[selectedAgentRunId] : undefined;
  $: selectedCommandCards = buildCommandCards(selectedAgentEvents);
  $: selectedNarrativeEvents = buildNarrativeEvents(selectedAgentEvents);
  $: selectedTaskRuns = selectedTask
    ? agentRuns.filter((run) => run.taskKey === canonicalTaskKey(selectedTask))
    : [];
  $: explorerShortcutLabel = platform === "darwin" ? "⌘⇧E" : "Ctrl+Shift+E";
  $: terminalShortcutLabel = platform === "darwin" ? "⌘`" : "Ctrl+`";
  $: chatShortcutLabel = platform === "darwin" ? "⌥L" : "Alt+L";
  $: chatActive = chatOpen && !editorOpen;
  $: if (workbenchStateReady && selectedCheckoutId) {
    persistWorkbenchState(selectedCheckoutId, {
      chatOpen,
      editorOpen,
      terminalOpen,
      terminalMaximized,
    });
  }

  onMount(() => {
    theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    const savedTaskView = window.localStorage.getItem(TASK_VIEW_STORAGE_KEY);
    if (savedTaskView === "list" || savedTaskView === "map") taskView = savedTaskView;
    const savedTerminalHeight = Number(window.localStorage.getItem(TERMINAL_HEIGHT_STORAGE_KEY));
    if (Number.isFinite(savedTerminalHeight) && savedTerminalHeight >= 180) terminalHeight = savedTerminalHeight;
    const planningClockTimer = window.setInterval(() => {
      planningClock = Date.now();
    }, 1_000);
    if (!window.phaseatlas) {
      errorMessage = "The desktop bridge is unavailable. Open this interface in the PhaseAtlas desktop app.";
      loading = false;
      return () => window.clearInterval(planningClockTimer);
    }

    const unsubscribe = window.phaseatlas.events.subscribe((event) => {
      if (event.checkoutId !== selectedCheckoutId) return;
      if (event.type === "planning.event") {
        handlePlanningEvent(event.event);
        return;
      }
      if (event.type === "task-content.event") {
        handleTaskContentEvent(event.event);
        return;
      }
      if (event.type === "agent-run.event") {
        void handleAgentRunEvent(event.runId, event.event);
        return;
      }
      if (event.type === "repository.changed") {
        window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(() => void refreshRepository(event.checkoutId), 180);
      }
    });
    const unsubscribeCloseSurface = window.phaseatlas.runtime.onCloseSurface(closeCurrentSurface);

    void initialize();
    return () => {
      window.clearTimeout(refreshTimer);
      window.clearInterval(planningClockTimer);
      unsubscribe();
      unsubscribeCloseSurface();
    };
  });

  async function initialize() {
    if (!window.phaseatlas) return;
    try {
      [repositories, platform] = await Promise.all([
        window.phaseatlas.repositories.list(),
        window.phaseatlas.runtime.platform(),
      ]);
      const savedWorkbenchState = readWorkbenchState();
      const savedRepository = repositories.find((repository) => repository.checkoutId === savedWorkbenchState?.selectedCheckoutId);
      const initialRepository = savedRepository ?? repositories[0];
      if (initialRepository) await selectRepository(initialRepository.checkoutId);
      workbenchStateReady = true;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "PhaseAtlas could not be initialized.";
    } finally {
      loading = false;
    }
  }

  function readWorkbenchState(): PersistedWorkbenchState | null {
    try {
      const persisted = window.localStorage.getItem(WORKBENCH_STATE_STORAGE_KEY);
      const value = JSON.parse(persisted ?? window.localStorage.getItem(LEGACY_WORKBENCH_STATE_STORAGE_KEY) ?? "null") as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const state = value as Record<string, unknown>;
      if (typeof state.selectedCheckoutId !== "string") return null;
      const parseSurface = (candidate: unknown): PersistedWorkbenchSurfaceState | null => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
        const surface = candidate as Record<string, unknown>;
        return {
          chatOpen: surface.chatOpen === true,
          editorOpen: surface.editorOpen === true,
          terminalOpen: surface.terminalOpen === true,
          terminalMaximized: surface.terminalOpen === true && surface.terminalMaximized === true,
        };
      };
      if (state.repositories && typeof state.repositories === "object" && !Array.isArray(state.repositories)) {
        const repositories = Object.fromEntries(Object.entries(state.repositories as Record<string, unknown>)
          .map(([checkoutId, candidate]) => [checkoutId, parseSurface(candidate)] as const)
          .filter((entry): entry is [string, PersistedWorkbenchSurfaceState] => Boolean(entry[1])));
        return { selectedCheckoutId: state.selectedCheckoutId, repositories };
      }
      const legacySurface = parseSurface(state);
      if (!legacySurface) return null;
      return {
        selectedCheckoutId: state.selectedCheckoutId,
        repositories: { [state.selectedCheckoutId]: legacySurface },
      };
    } catch {
      return null;
    }
  }

  function persistWorkbenchState(checkoutId: string, surface: PersistedWorkbenchSurfaceState) {
    const existing = readWorkbenchState();
    const state: PersistedWorkbenchState = {
      selectedCheckoutId: checkoutId,
      repositories: { ...existing?.repositories, [checkoutId]: surface },
    };
    window.localStorage.setItem(WORKBENCH_STATE_STORAGE_KEY, JSON.stringify(state));
    window.localStorage.removeItem(LEGACY_WORKBENCH_STATE_STORAGE_KEY);
  }

  function restoreWorkbenchState(state: PersistedWorkbenchSurfaceState | undefined) {
    if (!state) return;
    chatOpen = state.chatOpen;
    editorOpen = state.editorOpen;
    terminalOpen = state.terminalOpen;
    terminalMaximized = state.terminalOpen && state.terminalMaximized;
  }

  function clearWorkbenchState() {
    window.localStorage.removeItem(WORKBENCH_STATE_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_WORKBENCH_STATE_STORAGE_KEY);
  }

  function removeRepositoryWorkbenchState(checkoutId: string) {
    const existing = readWorkbenchState();
    if (!existing) return;
    const repositories = { ...existing.repositories };
    delete repositories[checkoutId];
    if (!Object.keys(repositories).length) {
      clearWorkbenchState();
      return;
    }
    const selectedCheckoutId = existing.selectedCheckoutId === checkoutId
      ? Object.keys(repositories)[0] ?? ""
      : existing.selectedCheckoutId;
    window.localStorage.setItem(WORKBENCH_STATE_STORAGE_KEY, JSON.stringify({ selectedCheckoutId, repositories }));
    window.localStorage.removeItem(LEGACY_WORKBENCH_STATE_STORAGE_KEY);
  }

  async function openRepository() {
    if (!window.phaseatlas || opening) return;
    opening = true;
    errorMessage = "";
    try {
      const repository = await window.phaseatlas.repositories.open();
      if (!repository) return;
      repositories = [
        repository,
        ...repositories.filter((item) => item.checkoutId !== repository.checkoutId),
      ];
      await selectRepository(repository.checkoutId);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "This repository could not be opened.";
    } finally {
      opening = false;
    }
  }

  async function selectRepository(checkoutId: string) {
    if (!window.phaseatlas) return;
    if (workbenchStateReady && selectedCheckoutId) {
      persistWorkbenchState(selectedCheckoutId, {
        chatOpen,
        editorOpen,
        terminalOpen,
        terminalMaximized,
      });
    }
    const savedSurface = readWorkbenchState()?.repositories[checkoutId];
    const requestId = ++repositoryLoadRequest;
    repositoryLoading = true;
    selectedCheckoutId = checkoutId;
    workspaces = [];
    runners = [];
    taskSnapshot = null;
    selectedWorkspaceSlug = "";
    selectedTaskKey = "";
    editorOpen = false;
    editorInitialPath = "";
    terminalOpen = false;
    terminalMaximized = false;
    contentPanelTaskKey = "";
    contentRuns = {};
    contentTaskStatuses = {};
    contentTaskRunIds = {};
    contentLogs = {};
    contentFailures = {};
    openEditorAfterTask = {};
    executionOpen = false;
    chatOpen = false;
    restoreWorkbenchState(savedSurface);
    executionActions = [];
    executionError = "";
    executionNotice = "";
    agentRuns = [];
    selectedAgentRunId = "";
    agentEvents = {};
    agentEventCursors = {};
    agentResultReviews = {};
    expandedCommandKeys = new Set();
    commandOutputs = {};
    errorMessage = "";
    menuOpen = false;
    try {
      const recoveredRepository = await window.phaseatlas.repositories.refresh(checkoutId);
      if (requestId !== repositoryLoadRequest || checkoutId !== selectedCheckoutId) return;
      const [nextWorkspaces, nextTaskSnapshot, nextRunners, activeContentRuns, nextAgentRuns] = await Promise.all([
        window.phaseatlas.workspaces.list(checkoutId),
        window.phaseatlas.tasks.snapshot(checkoutId),
        window.phaseatlas.runners.list(checkoutId),
        window.phaseatlas.tasks.listContentRuns(checkoutId),
        window.phaseatlas.agentRuns.list(checkoutId),
      ]);
      if (requestId !== repositoryLoadRequest || checkoutId !== selectedCheckoutId) return;
      workspaces = nextWorkspaces;
      repositories = repositories.map((repository) => repository.checkoutId === checkoutId ? recoveredRepository : repository);
      taskSnapshot = nextTaskSnapshot;
      runners = nextRunners;
      contentRuns = Object.fromEntries(activeContentRuns.map((run) => [run.runId, {
        status: run.status,
        taskKeys: run.taskKeys,
      }]));
      contentTaskStatuses = Object.fromEntries(activeContentRuns.flatMap((run) =>
        run.taskKeys.map((taskKey) => [taskKey, run.status]),
      ));
      contentTaskRunIds = Object.fromEntries(activeContentRuns.flatMap((run) =>
        run.taskKeys.map((taskKey) => [taskKey, run.runId]),
      ));
      agentRuns = nextAgentRuns;
      const savedAgentRun = readSelectedAgentRuns()[checkoutId];
      selectedAgentRunId = nextAgentRuns.some((run) => run.runId === savedAgentRun)
        ? savedAgentRun
        : nextAgentRuns[0]?.runId ?? "";
      applyRepositoryProviderSettings(checkoutId);
      selectWorkspace(workspaces[0]?.slug ?? "");
    } catch (error) {
      if (requestId !== repositoryLoadRequest || checkoutId !== selectedCheckoutId) return;
      errorMessage = error instanceof Error ? error.message : "The repository workspaces could not be read.";
    } finally {
      if (requestId === repositoryLoadRequest && checkoutId === selectedCheckoutId) repositoryLoading = false;
    }
  }

  async function toggleTerminal() {
    if (!selectedCheckoutId) return;
    if (terminalOpen) {
      await closeTerminal();
      return;
    }
    terminalOpen = true;
    await tick();
    terminalPanel?.focus();
  }

  async function closeTerminal(restoreEditorFocus = true) {
    terminalOpen = false;
    terminalMaximized = false;
    if (!restoreEditorFocus || !editorOpen) return;
    await tick();
    repositoryWorkbench?.focusActiveEditor();
  }

  function updateTerminalHeight(nextHeight: number) {
    terminalHeight = Math.round(nextHeight);
    window.localStorage.setItem(TERMINAL_HEIGHT_STORAGE_KEY, String(terminalHeight));
  }

  function readRepositoryProviderSettings(): RepositoryProviderSettings {
    try {
      const stored = JSON.parse(window.localStorage.getItem(PROVIDER_SETTINGS_STORAGE_KEY) ?? "{}") as unknown;
      if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
      return stored as RepositoryProviderSettings;
    } catch {
      return {};
    }
  }

  function defaultModelId(runner: RunnerDescriptor | undefined): string {
    return runner?.models?.find((model) => model.isDefault)?.id ?? runner?.models?.[0]?.id ?? "";
  }

  function defaultReasoningEffort(modelId: string, runnerId = plannerRunnerId): string {
    const model = runners.find((runner) => runner.id === runnerId)?.models.find((candidate) => candidate.id === modelId);
    return model?.defaultReasoningEffort && model.reasoningEfforts.includes(model.defaultReasoningEffort)
      ? model.defaultReasoningEffort
      : "";
  }

  function applyRepositoryProviderSettings(checkoutId: string) {
    const saved = readRepositoryProviderSettings()[checkoutId];
    const runner = runners.find((candidate) => candidate.available && candidate.id === saved?.runnerId)
      ?? runners.find((candidate) => candidate.available && candidate.models?.length > 0)
      ?? runners.find((candidate) => candidate.available);
    plannerRunnerId = runner?.id ?? "";
    plannerModel = runner?.models?.some((model) => model.id === saved?.modelId)
      ? saved.modelId
      : defaultModelId(runner);
    const selectedModel = runner?.models.find((model) => model.id === plannerModel);
    plannerReasoningEffort = saved?.reasoningEffort && selectedModel?.reasoningEfforts.includes(saved.reasoningEffort)
      ? saved.reasoningEffort
      : selectedModel?.defaultReasoningEffort && selectedModel.reasoningEfforts.includes(selectedModel.defaultReasoningEffort)
        ? selectedModel.defaultReasoningEffort
        : "";
    if (plannerRunnerId && plannerModel) persistRepositoryProviderSettings();
  }

  function persistRepositoryProviderSettings() {
    if (!selectedCheckoutId || !plannerRunnerId || !plannerModel) return;
    const settings = readRepositoryProviderSettings();
    settings[selectedCheckoutId] = {
      runnerId: plannerRunnerId,
      modelId: plannerModel,
      ...(plannerReasoningEffort ? { reasoningEffort: plannerReasoningEffort } : {}),
    };
    window.localStorage.setItem(PROVIDER_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }

  function selectProviderRunner(runnerId: string) {
    plannerRunnerId = runnerId;
    plannerModel = defaultModelId(runners.find((runner) => runner.id === runnerId));
    plannerReasoningEffort = defaultReasoningEffort(plannerModel, runnerId);
    persistRepositoryProviderSettings();
    if (executionOpen && selectedTask) void loadExecutionActions(selectedTask);
  }

  // Shared by the repository bar and the chat composer picker: one repository-wide
  // selection, persisted per checkout, regardless of which surface changed it.
  function applyProviderSelection(nextRunnerId: string, nextModelId: string, nextReasoningEffort: string) {
    const runner = runners.find((candidate) => candidate.id === nextRunnerId);
    const model = runner?.models.find((candidate) => candidate.id === nextModelId);
    if (!runner || !model) return;
    plannerRunnerId = nextRunnerId;
    plannerModel = nextModelId;
    plannerReasoningEffort = nextReasoningEffort && model.reasoningEfforts.includes(nextReasoningEffort)
      ? nextReasoningEffort
      : "";
    persistRepositoryProviderSettings();
    if (executionOpen && selectedTask) void loadExecutionActions(selectedTask);
  }

  function selectProviderModel(modelId: string) {
    if (!selectedModels.some((candidate) => candidate.id === modelId)) return;
    plannerModel = modelId;
    plannerReasoningEffort = defaultReasoningEffort(modelId);
    persistRepositoryProviderSettings();
    if (executionOpen && selectedTask) void loadExecutionActions(selectedTask);
  }

  function selectProviderReasoningEffort(reasoningEffort: string) {
    if (reasoningEffort && !selectedReasoningEfforts.includes(reasoningEffort)) return;
    plannerReasoningEffort = reasoningEffort;
    persistRepositoryProviderSettings();
    if (executionOpen && selectedTask) void loadExecutionActions(selectedTask);
  }

  // A path cited in a result or an answer is a claim about this repository; opening
  // it lets the user check the claim without leaving the run panel.
  async function openRepositoryPathInEditor(repositoryPath: string) {
    if (!window.phaseatlas || !selectedCheckoutId || !repositoryPath) return;
    const requestId = ++openedFileRequest;
    openedFilePath = repositoryPath;
    openedFileContent = "";
    openedFileError = "";
    openedFileLoading = true;
    try {
      const document = await window.phaseatlas.files.read(selectedCheckoutId, repositoryPath);
      if (requestId !== openedFileRequest) return;
      openedFilePath = document.path;
      openedFileContent = document.content;
      openedFileMode = "preview";
    } catch (error) {
      if (requestId !== openedFileRequest) return;
      openedFileError = error instanceof Error ? error.message : "The file could not be opened.";
    } finally {
      if (requestId === openedFileRequest) openedFileLoading = false;
    }
  }

  function closeOpenedFile() {
    openedFileRequest += 1;
    openedFilePath = "";
    openedFileContent = "";
    openedFileError = "";
    openedFileLoading = false;
  }

  async function revealAgentConfiguration() {
    chatOpen = false;
    await tick();
    agentConfigurationElement?.scrollIntoView({ behavior: "smooth", block: "center" });
    agentConfigurationElement?.querySelector<HTMLSelectElement>("select")?.focus({ preventScroll: true });
  }

  async function refreshRepository(checkoutId: string) {
    if (!window.phaseatlas || refreshing || checkoutId !== selectedCheckoutId) return;
    refreshing = true;
    errorMessage = "";
    try {
      const repository = await window.phaseatlas.repositories.refresh(checkoutId);
      // Provider availability is discovered, not static: a CLI can be installed,
      // signed in, or upgraded while the repository stays open. Refresh has to
      // re-probe, otherwise fixing a sign-in requires reopening the repository.
      const [nextWorkspaces, nextTaskSnapshot, nextRunners] = await Promise.all([
        window.phaseatlas.workspaces.list(checkoutId),
        window.phaseatlas.tasks.snapshot(checkoutId),
        window.phaseatlas.runners.list(checkoutId),
      ]);
      repositories = repositories.map((item) => item.checkoutId === checkoutId ? repository : item);
      workspaces = nextWorkspaces;
      taskSnapshot = nextTaskSnapshot;
      runners = nextRunners;
      applyRepositoryProviderSettings(checkoutId);
      const workspaceSlug = nextWorkspaces.some((item) => item.slug === selectedWorkspaceSlug)
        ? selectedWorkspaceSlug
        : nextWorkspaces[0]?.slug ?? "";
      selectWorkspace(workspaceSlug, selectedTaskKey);
      if (executionOpen) {
        await loadAgentRuns(selectedAgentRunId);
        await loadTaskConversationEvents();
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "The repository could not be refreshed.";
    } finally {
      refreshing = false;
    }
  }

  function selectWorkspace(workspaceSlug: string, preferredTaskKey = "") {
    selectedWorkspaceSlug = workspaceSlug;
    const tasks = (taskSnapshot?.tasks ?? []).filter((task) => task.key.workspaceSlug === workspaceSlug);
    selectedTaskKey = tasks.some((task) => canonicalTaskKey(task) === preferredTaskKey)
      ? preferredTaskKey
      : tasks[0] ? canonicalTaskKey(tasks[0]) : "";
  }

  function selectTask(task: CanonicalTask) {
    selectedTaskKey = canonicalTaskKey(task);
    contentPanelTaskKey = canonicalTaskKey(task);
    if (executionOpen) void loadExecutionActions(task);
  }

  function openTaskDetails(task: CanonicalTask) {
    selectedTaskKey = canonicalTaskKey(task);
    contentPanelTaskKey = "";
    setTaskView("list");
  }

  function setTaskView(view: "list" | "map") {
    taskView = view;
    window.localStorage.setItem(TASK_VIEW_STORAGE_KEY, view);
  }

  function moveTaskView(event: KeyboardEvent, index: number) {
    const views: Array<"list" | "map"> = ["list", "map"];
    let nextIndex = index;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % views.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + views.length) % views.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = views.length - 1;
    else return;
    event.preventDefault();
    setTaskView(views[nextIndex]);
  }

  async function handleTaskContentEvent(event: TaskContentEvent) {
    if (event.type === "task-content.status") {
      contentRuns = {
        ...contentRuns,
        [event.runId]: { status: event.status, taskKeys: event.taskKeys },
      };
      contentTaskStatuses = {
        ...contentTaskStatuses,
        ...Object.fromEntries(event.taskKeys.map((taskKey) => [taskKey, event.status])),
      };
      contentTaskRunIds = {
        ...contentTaskRunIds,
        ...Object.fromEntries(event.taskKeys.map((taskKey) => [taskKey, event.runId])),
      };
      if (["completed", "failed", "cancelled"].includes(event.status) && window.phaseatlas) {
        taskSnapshot = await window.phaseatlas.tasks.snapshot(selectedCheckoutId);
      }
      return;
    }
    if (event.type === "task-content.delta") {
      contentLogs = {
        ...contentLogs,
        [event.taskKey]: `${contentLogs[event.taskKey] ?? ""}${event.text}`.slice(-12_000),
      };
      return;
    }
    if (event.type === "task-content.task-failed") {
      contentFailures = { ...contentFailures, [event.taskKey]: event.message };
      contentTaskStatuses = { ...contentTaskStatuses, [event.taskKey]: "failed" };
      return;
    }
    if (event.type === "task-content.task-completed") {
      contentTaskStatuses = { ...contentTaskStatuses, [event.taskKey]: "completed" };
      if (window.phaseatlas) taskSnapshot = await window.phaseatlas.tasks.snapshot(selectedCheckoutId);
      if (openEditorAfterTask[event.taskKey]) {
        editorInitialPath = event.contentPath;
        editorOpen = true;
        openEditorAfterTask = { ...openEditorAfterTask, [event.taskKey]: false };
      }
    }
  }

  async function initializeTaskContent(taskKeys: string[], openAfter = false) {
    if (!window.phaseatlas || !taskKeys.length) return;
    if (!providerSelectionReady) {
      errorMessage = "Choose an available CLI and model from Agent configuration before initializing task content.";
      return;
    }
    const requestedTaskKeys = [...new Set(taskKeys)].filter((taskKey) => !activeContentTaskKeys.has(taskKey));
    if (!requestedTaskKeys.length) return;
    contentTaskStatuses = {
      ...contentTaskStatuses,
      ...Object.fromEntries(requestedTaskKeys.map((taskKey) => [taskKey, "starting"])),
    };
    contentLogs = {
      ...contentLogs,
      ...Object.fromEntries(requestedTaskKeys.map((taskKey) => [taskKey, ""])),
    };
    contentFailures = Object.fromEntries(
      Object.entries(contentFailures).filter(([taskKey]) => !requestedTaskKeys.includes(taskKey)),
    );
    if (openAfter && requestedTaskKeys.length === 1) {
      openEditorAfterTask = { ...openEditorAfterTask, [requestedTaskKeys[0]]: true };
    }
    try {
      const result = await window.phaseatlas.tasks.initializeContent(selectedCheckoutId, {
        taskKeys: requestedTaskKeys,
        runnerId: plannerRunnerId,
        ...(plannerModel.trim() ? { model: plannerModel.trim() } : {}),
        ...(plannerReasoningEffort ? { reasoningEffort: plannerReasoningEffort } : {}),
      });
      contentRuns = {
        ...contentRuns,
        [result.runId]: contentRuns[result.runId] ?? { status: "starting", taskKeys: requestedTaskKeys },
      };
      contentTaskRunIds = {
        ...contentTaskRunIds,
        ...Object.fromEntries(requestedTaskKeys.map((taskKey) => [taskKey, result.runId])),
      };
    } catch (error) {
      contentTaskStatuses = {
        ...contentTaskStatuses,
        ...Object.fromEntries(requestedTaskKeys.map((taskKey) => [taskKey, "failed"])),
      };
      errorMessage = error instanceof Error ? error.message : "Task content initialization could not start.";
    }
  }

  function openRepositoryEditor(path = "") {
    contentPanelTaskKey = "";
    editorInitialPath = path;
    editorOpen = true;
  }

  function editTaskContent(task: CanonicalTask) {
    if (!task.content) return;
    openRepositoryEditor(task.content.path);
  }

  async function handleEditorSaved(path: string) {
    if (!window.phaseatlas || !path.startsWith(".phaseatlas/")) return;
    taskSnapshot = await window.phaseatlas.tasks.snapshot(selectedCheckoutId);
  }

  function readSelectedAgentRuns(): Record<string, string> {
    try {
      const value = JSON.parse(window.localStorage.getItem(SELECTED_AGENT_RUN_STORAGE_KEY) ?? "{}") as unknown;
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, string> : {};
    } catch {
      return {};
    }
  }

  function rememberSelectedAgentRun(runId: string) {
    if (!selectedCheckoutId || !runId) return;
    const selections = readSelectedAgentRuns();
    selections[selectedCheckoutId] = runId;
    window.localStorage.setItem(SELECTED_AGENT_RUN_STORAGE_KEY, JSON.stringify(selections));
  }

  async function openExecutionWorkbench(task: CanonicalTask | undefined = selectedTask) {
    if (!window.phaseatlas) return;
    if (!executionOpen) {
      executionReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    if (task) selectedTaskKey = canonicalTaskKey(task);
    contentPanelTaskKey = "";
    executionOpen = true;
    executionError = "";
    executionNotice = "";
    await tick();
    executionPanelElement?.focus();
    await Promise.all([
      loadAgentRuns(selectedAgentRunId),
      task ? loadExecutionActions(task) : Promise.resolve(),
    ]);
    if (selectedAgentRunId) await selectAgentRun(selectedAgentRunId);
    await loadTaskConversationEvents();
  }

  function closeExecutionWorkbench() {
    const returnFocus = executionReturnFocus;
    executionOpen = false;
    executionConfirmAction = null;
    executionScopeConfirmed = false;
    executionError = "";
    executionReturnFocus = null;
    void tick().then(() => returnFocus?.focus());
  }

  async function loadExecutionActions(task: CanonicalTask) {
    if (!window.phaseatlas) return;
    const requestId = ++executionActionRequest;
    const checkoutId = selectedCheckoutId;
    executionActionsLoading = true;
    executionError = "";
    if (!providerSelectionReady) {
      executionActions = (["analyze", "plan", "implement", "review"] as AgentRunAction[]).map((action) => ({
        action,
        sandbox: action === "implement" ? "workspace-write" : "read-only",
        available: false,
        blockingReasons: ["Choose an available CLI and model from Agent configuration."],
      }));
      executionActionsLoading = false;
      return;
    }
    try {
      const nextActions = await window.phaseatlas.agentRuns.actions(checkoutId, {
        taskKey: canonicalTaskKey(task),
        runnerId: plannerRunnerId,
        ...(plannerModel ? { model: plannerModel } : {}),
        ...(plannerReasoningEffort ? { reasoningEffort: plannerReasoningEffort } : {}),
      });
      if (requestId === executionActionRequest && checkoutId === selectedCheckoutId) executionActions = nextActions;
    } catch (error) {
      if (requestId === executionActionRequest && checkoutId === selectedCheckoutId) {
        executionActions = [];
        executionError = error instanceof Error ? error.message : "Task actions could not be evaluated.";
      }
    } finally {
      if (requestId === executionActionRequest) executionActionsLoading = false;
    }
  }

  async function loadAgentRuns(preferredRunId = "") {
    if (!window.phaseatlas || !selectedCheckoutId) return;
    const requestId = ++agentRunListRequest;
    const checkoutId = selectedCheckoutId;
    try {
      const nextRuns = await window.phaseatlas.agentRuns.list(checkoutId);
      if (requestId !== agentRunListRequest || checkoutId !== selectedCheckoutId) return;
      agentRuns = nextRuns;
      const nextSelected = nextRuns.find((run) => run.runId === preferredRunId)?.runId
        ?? nextRuns.find((run) => run.runId === selectedAgentRunId)?.runId
        ?? nextRuns[0]?.runId
        ?? "";
      selectedAgentRunId = nextSelected;
      if (nextSelected) rememberSelectedAgentRun(nextSelected);
    } catch (error) {
      if (requestId === agentRunListRequest && checkoutId === selectedCheckoutId) {
        executionError = error instanceof Error ? error.message : "Run history could not be loaded.";
      }
    }
  }

  function requestAgentAction(availability: AgentRunActionAvailability) {
    if (!availability.available || executionStartingAction) return;
    executionError = "";
    executionNotice = "";
    if (availability.sandbox === "workspace-write") {
      executionConfirmAction = availability;
      executionScopeConfirmed = false;
      void tick().then(() => executionConfirmElement?.focus());
      return;
    }
    void startAgentRun(availability);
  }

  async function startAgentRun(availability: AgentRunActionAvailability) {
    if (!window.phaseatlas || !selectedTask || !availability.available || executionStartingAction) return;
    executionStartingAction = availability.action;
    executionError = "";
    executionNotice = `Preparing ${availability.action} run…`;
    try {
      const started = await window.phaseatlas.agentRuns.start(selectedCheckoutId, {
        taskKey: canonicalTaskKey(selectedTask),
        expectedTaskRevision: selectedTask.revision,
        expectedCheckoutId: selectedCheckoutId,
        action: availability.action,
        requestedSandbox: availability.sandbox,
        runnerId: plannerRunnerId,
        ...(plannerModel ? { model: plannerModel } : {}),
        ...(plannerReasoningEffort ? { reasoningEffort: plannerReasoningEffort } : {}),
      });
      executionConfirmAction = null;
      executionScopeConfirmed = false;
      executionNotice = `${actionLabel(availability.action)} run started.`;
      await loadAgentRuns(started.runId);
      await selectAgentRun(started.runId);
      if (selectedTask) await loadExecutionActions(selectedTask);
    } catch (error) {
      executionError = error instanceof Error ? error.message : "The agent run could not start.";
      executionNotice = "";
      if (selectedTask) await loadExecutionActions(selectedTask);
    } finally {
      executionStartingAction = "";
    }
  }

  // The task conversation renders every stage, not just the selected run, so the
  // transcript needs each stage's events rather than only the focused one.
  async function loadTaskConversationEvents() {
    for (const run of pipelineRuns) {
      if (agentEvents[run.runId]?.length) continue;
      await reconcileAgentEvents(run.runId).catch(() => undefined);
    }
  }

  async function selectAgentRun(runId: string) {
    if (!runId) return;
    selectedAgentRunId = runId;
    rememberSelectedAgentRun(runId);
    executionError = "";
    expandedCommandKeys = new Set();
    commandOutputs = {};
    await reconcileAgentEvents(runId);
    const run = agentRuns.find((candidate) => candidate.runId === runId);
    if (run && ["completed", "failed"].includes(run.status)) await loadAgentResult(runId);
  }

  function mergeAgentEvents(runId: string, incoming: PersistedRunEvent[]) {
    const merged = new Map((agentEvents[runId] ?? []).map((event) => [event.sequence, event]));
    for (const event of incoming) merged.set(event.sequence, event);
    const ordered = [...merged.values()].sort((left, right) => left.sequence - right.sequence);
    let contiguous = 0;
    for (const event of ordered) {
      if (event.sequence !== contiguous + 1) break;
      contiguous = event.sequence;
    }
    agentEvents = { ...agentEvents, [runId]: ordered };
    agentEventCursors = { ...agentEventCursors, [runId]: contiguous };
  }

  async function reconcileAgentEvents(runId: string) {
    if (!window.phaseatlas) return;
    const checkoutId = selectedCheckoutId;
    const reconciliationKey = `${checkoutId}:${runId}`;
    if (reconcilingAgentRuns.has(reconciliationKey)) return;
    reconcilingAgentRuns.add(reconciliationKey);
    let stalledOnGap = false;
    try {
      let cursor = agentEventCursors[runId] ?? 0;
      for (;;) {
        const page = await window.phaseatlas.agentRuns.events(checkoutId, runId, cursor, 200);
        if (checkoutId !== selectedCheckoutId) return;
        if (page.runId !== runId || page.afterSequence !== cursor) {
          throw new Error("Persisted event page does not match the requested run cursor.");
        }
        const previousCursor = cursor;
        mergeAgentEvents(runId, page.events);
        cursor = agentEventCursors[runId] ?? cursor;
        if (page.events.length && cursor === previousCursor) {
          stalledOnGap = true;
          throw new Error(`Persisted event sequence has a gap after ${previousCursor}.`);
        }
        if (page.hasMore && !page.events.length) {
          stalledOnGap = true;
          throw new Error("Persisted event page cannot advance its cursor.");
        }
        if (!page.hasMore) break;
      }
    } catch (error) {
      executionError = error instanceof Error ? error.message : "Run events could not be resumed.";
    } finally {
      reconcilingAgentRuns.delete(reconciliationKey);
      const highestObserved = (agentEvents[runId] ?? []).at(-1)?.sequence ?? 0;
      if (!stalledOnGap && checkoutId === selectedCheckoutId && highestObserved > (agentEventCursors[runId] ?? 0)) {
        void reconcileAgentEvents(runId);
      }
    }
  }

  async function handleAgentRunEvent(runId: string, event: PersistedRunEvent) {
    const priorCursor = agentEventCursors[runId] ?? 0;
    mergeAgentEvents(runId, [event]);
    if (event.sequence > priorCursor + 1) await reconcileAgentEvents(runId);
    const status = agentEventStatus(event);
    if (status) {
      if (agentRuns.some((run) => run.runId === runId)) {
        agentRuns = agentRuns.map((run) => run.runId === runId
          ? { ...run, status, updatedAt: event.timestamp }
          : run);
      } else {
        await loadAgentRuns(runId);
      }
      if (["completed", "failed", "cancelled", "interrupted"].includes(status)) {
        await loadAgentRuns(runId);
        if (["completed", "failed"].includes(status)) await loadAgentResult(runId);
      }
      if (selectedTask) await loadExecutionActions(selectedTask);
    }
  }

  function agentEventStatus(event: PersistedRunEvent): AgentRunSummary["status"] | undefined {
    if (event.type === "run.status" && ["starting", "running", "cancelled"].includes(String(event.payload.status))) {
      return event.payload.status as "starting" | "running" | "cancelled";
    }
    if (event.type === "agent.result" && ["completed", "failed"].includes(String(event.payload.status))) {
      return event.payload.status as "completed" | "failed";
    }
    if (event.type === "run.failed") return "failed";
    if (event.type === "run.cancelled") return "cancelled";
    if (event.type === "run.interrupted") return "interrupted";
    return undefined;
  }

  async function loadAgentResult(runId: string) {
    if (!window.phaseatlas) return;
    const checkoutId = selectedCheckoutId;
    try {
      const review = await window.phaseatlas.agentRuns.result(checkoutId, runId);
      if (checkoutId === selectedCheckoutId) agentResultReviews = { ...agentResultReviews, [runId]: review };
    } catch {
      if (checkoutId === selectedCheckoutId) {
        agentResultReviews = Object.fromEntries(Object.entries(agentResultReviews).filter(([key]) => key !== runId));
      }
    }
  }

  async function cancelAgentRun(runId: string) {
    if (!window.phaseatlas || cancellingAgentRunId) return;
    cancellingAgentRunId = runId;
    executionError = "";
    executionNotice = "Stopping the owned provider process…";
    try {
      const result = await window.phaseatlas.agentRuns.cancel(selectedCheckoutId, runId);
      executionNotice = result.status === "cancelled" ? "Run cancelled after provider exit." : `Run is already ${result.status}.`;
      await Promise.all([loadAgentRuns(runId), reconcileAgentEvents(runId)]);
    } catch (error) {
      executionError = error instanceof Error ? error.message : "The run could not be cancelled.";
    } finally {
      cancellingAgentRunId = "";
    }
  }

  async function recoverAgentRun(runId: string, decision: "leave_interrupted" | "retry") {
    if (!window.phaseatlas || recoveringAgentRunId) return;
    recoveringAgentRunId = runId;
    executionError = "";
    try {
      const result = await window.phaseatlas.agentRuns.recover(selectedCheckoutId, {
        runId,
        decision,
        ...(decision === "retry" ? {
          runnerId: plannerRunnerId,
          ...(plannerModel ? { model: plannerModel } : {}),
          ...(plannerReasoningEffort ? { reasoningEffort: plannerReasoningEffort } : {}),
        } : {}),
      });
      executionNotice = decision === "retry" ? "A linked retry was created from the current task revision." : "Interrupted attempt retained as history.";
      await loadAgentRuns(result.retryRunId ?? runId);
      if (result.retryRunId) await selectAgentRun(result.retryRunId);
    } catch (error) {
      executionError = error instanceof Error ? error.message : "The interrupted run could not be recovered.";
    } finally {
      recoveringAgentRunId = "";
    }
  }

  function buildCommandCards(events: PersistedRunEvent[]): CommandCard[] {
    const commands = new Map<string, CommandCard>();
    for (const event of events) {
      const commandId = typeof event.payload.commandId === "string" ? event.payload.commandId : "";
      if (!commandId) continue;
      const current = commands.get(commandId) ?? { commandId, command: "Repository command", outputCharacters: 0, sequence: event.sequence };
      if (event.type === "command.started" && typeof event.payload.command === "string") current.command = event.payload.command;
      if (event.type === "command.output" && typeof event.payload.characterCount === "number") {
        current.outputCharacters += event.payload.characterCount;
      }
      if (event.type === "command.completed" && typeof event.payload.exitCode === "number") current.exitCode = event.payload.exitCode;
      commands.set(commandId, current);
    }
    return [...commands.values()].sort((left, right) => left.sequence - right.sequence);
  }

  function buildNarrativeEvents(events: PersistedRunEvent[]): PersistedRunEvent[] {
    const deltas = events.filter((event) => event.type === "agent.delta" && typeof event.payload.text === "string");
    const narrative: PersistedRunEvent[] = [];
    if (deltas.length) {
      let text = "";
      let previousChunkLength = 0;
      for (const event of deltas) {
        const chunk = event.payload.text as string;
        const separator = text && previousChunkLength > 40 && chunk.length > 40 ? "\n\n" : "";
        text += `${separator}${chunk}`;
        previousChunkLength = chunk.length;
      }
      const first = deltas[0] as PersistedRunEvent;
      narrative.push({ ...first, payload: { ...first.payload, text: text.trimEnd() } });
    }
    narrative.push(...events.filter((event) =>
      ["run.failed", "run.cancelled", "run.interrupted"].includes(event.type) ||
      (event.type === "turn.completed" && !deltas.length)
    ));
    return narrative.sort((left, right) => left.sequence - right.sequence);
  }

  function commandOutputKey(runId: string, commandId: string) {
    return `${runId}:${commandId}`;
  }

  async function toggleCommandOutput(runId: string, commandId: string) {
    const key = commandOutputKey(runId, commandId);
    if (expandedCommandKeys.has(key)) {
      expandedCommandKeys = new Set([...expandedCommandKeys].filter((candidate) => candidate !== key));
      commandOutputs = Object.fromEntries(Object.entries(commandOutputs).filter(([candidate]) => candidate !== key));
      return;
    }
    expandedCommandKeys = new Set([...expandedCommandKeys, key]);
    await loadCommandOutput(runId, commandId, 0);
  }

  async function loadCommandOutput(runId: string, commandId: string, offset: number) {
    if (!window.phaseatlas) return;
    const key = commandOutputKey(runId, commandId);
    const previous = commandOutputs[key];
    commandOutputs = {
      ...commandOutputs,
      [key]: {
        text: previous?.text ?? "",
        offset: previous?.offset ?? offset,
        nextOffset: offset,
        totalCharacters: previous?.totalCharacters ?? 0,
        hasMore: previous?.hasMore ?? false,
        loading: true,
        error: "",
      },
    };
    try {
      const page = await window.phaseatlas.agentRuns.commandOutput(selectedCheckoutId, runId, commandId, offset, 20_000);
      if (!expandedCommandKeys.has(key) || page.runId !== runId || page.commandId !== commandId) return;
      commandOutputs = {
        ...commandOutputs,
        [key]: {
          text: page.text,
          offset: page.offset,
          nextOffset: page.nextOffset,
          totalCharacters: page.totalCharacters,
          hasMore: page.hasMore,
          loading: false,
          error: "",
        },
      };
    } catch (error) {
      if (!expandedCommandKeys.has(key)) return;
      commandOutputs = {
        ...commandOutputs,
        [key]: {
          text: previous?.text ?? "",
          offset: previous?.offset ?? offset,
          nextOffset: offset,
          totalCharacters: previous?.totalCharacters ?? 0,
          hasMore: previous?.hasMore ?? false,
          loading: false,
          error: error instanceof Error ? error.message : "Command output could not be loaded.",
        },
      };
    }
  }

  function formatCharacterCount(value: number) {
    if (value < 1_000) return `${value} chars`;
    return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k chars`;
  }

  function formatCharacterPosition(value: number) {
    return value.toLocaleString("en-US");
  }

  function eventHeading(event: PersistedRunEvent) {
    const labels: Record<string, string> = {
      "agent.prepared": "Run prepared",
      "run.status": `Run ${String(event.payload.status ?? "updated")}`,
      "agent.delta": "Agent message",
      "command.started": "Command",
      "file.changed": "File changed",
      "turn.completed": "Turn completed",
      "agent.result": "Validated result",
      "run.failed": "Run failed",
      "run.cancelled": "Run cancelled",
      "run.interrupted": "Run interrupted",
    };
    return labels[event.type] ?? event.type.replaceAll(".", " ");
  }

  function eventBody(event: PersistedRunEvent) {
    for (const key of ["text", "summary", "message", "path", "reason"] as const) {
      if (typeof event.payload[key] === "string") return event.payload[key] as string;
    }
    return "";
  }

  function actionLabel(action: AgentRunAction) {
    return ({ analyze: "Analyze", plan: "Plan", implement: "Implement", review: "Review" })[action];
  }

  function formatRunTime(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function isAgentRunActive(run: AgentRunSummary | null) {
    return Boolean(run && (run.status === "starting" || run.status === "running"));
  }

  function canonicalTaskKey(task: CanonicalTask) {
    return `${task.key.workspaceSlug}/${task.key.taskId}`;
  }

  function stateLabel(state: CanonicalTask["state"]) {
    return state.replaceAll("_", " ");
  }

  function openPlanner(mode: PlanningTarget["type"] = selectedWorkspaceSlug ? "workspace" : "repository") {
    plannerMode = mode;
    plannerOpen = true;
    plannerError = "";
    published = false;
    if (!plannerRunnerId) applyRepositoryProviderSettings(selectedCheckoutId);
  }

  function planningTarget(): PlanningTarget {
    return plannerMode === "repository"
      ? { type: "repository" }
      : { type: "workspace", workspaceSlug: selectedWorkspaceSlug };
  }

  function closePlanner() {
    if (planningActive) return;
    plannerOpen = false;
  }

  function handlePlanningEvent(event: import("@phaseatlas/contracts").PlanningEvent) {
    if (planningRunId && event.runId !== planningRunId) return;
    if (!planningRunId) planningRunId = event.runId;
    if (!planningStartedAt) planningStartedAt = Date.now();
    planningLastActivityAt = Date.now();
    planningEventCount += 1;
    if (event.type === "planning.status") {
      planningStatus = event.status;
      if (["completed", "failed", "cancelled"].includes(event.status)) {
        planningEndedAt = Date.now();
      }
    }
    if (event.type === "planning.delta") {
      planningLog = `${planningLog}${event.text}`.slice(-40_000);
      if (streamExpanded && streamAutofollow) void scrollPlanningTail();
    }
    if (event.type === "planning.completed") {
      proposals = event.proposals;
      planningStatus = "completed";
      planningEndedAt = Date.now();
      streamExpanded = false;
    }
    if (event.type === "planning.failed") {
      plannerError = event.message;
      planningStatus = "failed";
      planningEndedAt = Date.now();
      streamExpanded = true;
    }
  }

  function normalizePlanningLog(value: string) {
    return value
      .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\r(?!\n)/g, "\n")
      .replace(/\n{4,}/g, "\n\n\n");
  }

  function streamLineKind(value: string) {
    const line = value.trim();
    if (/^PhaseAtlas ·/i.test(line)) return "heartbeat";
    if (/^(Thinking|Agent is|Turn completed|Session opened)\b/i.test(line)) return "agent";
    if (/^(error|fatal|failed|panic)\b/i.test(line)) return "error";
    if (/^(warning|warn)\b/i.test(line)) return "warning";
    if (/^(exec|read|search|tool|command|\$|›|→)\b/i.test(line)) return "operation";
    if (/^[{}\[\],]|^"[\w-]+"\s*:/.test(line)) return "data";
    return line ? "text" : "blank";
  }

  function formatPlanningDuration(milliseconds: number) {
    const seconds = Math.floor(milliseconds / 1_000);
    const minutes = Math.floor(seconds / 60);
    return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function formatStreamSize(length: number) {
    return length < 1_000 ? `${length} B` : `${(length / 1_000).toFixed(1)} KB`;
  }

  function streamSummary() {
    if (planningStatus === "completed" && proposals) {
      const workspaceCount = proposals.workspaces.length;
      return `${workspaceCount ? `${workspaceCount} workspace · ` : ""}${proposals.tasks.length} ${proposals.tasks.length === 1 ? "task" : "tasks"} ready for review`;
    }
    if (planningStatus === "failed") return "Runner stopped before producing valid proposals";
    if (planningStatus === "cancelled") return "Planning run cancelled";
    if (planningActive && !planningLog && planningSilenceMs >= 45_000) {
      return `Agent is active · no provider output for ${formatPlanningDuration(planningSilenceMs)}`;
    }
    return "Repository inspection and proposal composition in progress";
  }

  function waitingTitle() {
    if (planningStatus === "starting") return "Starting provider session";
    if (planningSilenceMs >= 45_000) return "Agent is still working";
    return "Agent is inspecting the repository";
  }

  function waitingDetail() {
    if (planningSilenceMs >= 45_000) {
      return `No provider output for ${formatPlanningDuration(planningSilenceMs)} · heartbeat is live`;
    }
    return `Live heartbeat · ${formatPlanningDuration(planningElapsedMs)} elapsed`;
  }

  async function scrollPlanningTail() {
    await tick();
    if (!planningViewport || !streamAutofollow) return;
    planningViewport.scrollTop = planningViewport.scrollHeight;
  }

  function handleStreamScroll() {
    if (!planningViewport) return;
    const distanceFromBottom = planningViewport.scrollHeight - planningViewport.scrollTop - planningViewport.clientHeight;
    const shouldFollow = distanceFromBottom < 24;
    if (shouldFollow !== streamAutofollow) streamAutofollow = shouldFollow;
  }

  function resumeStreamTail() {
    streamAutofollow = true;
    void scrollPlanningTail();
  }

  async function startPlanning() {
    if (
      !window.phaseatlas ||
      (plannerMode === "workspace" && !selectedWorkspaceSlug) ||
      !providerSelectionReady ||
      !plannerRequest.trim()
    ) return;
    planningRunId = "";
    planningStatus = "starting";
    planningLog = "";
    planningStartedAt = Date.now();
    planningEndedAt = 0;
    planningLastActivityAt = planningStartedAt;
    planningClock = Date.now();
    planningEventCount = 0;
    streamExpanded = true;
    streamAutofollow = true;
    proposals = null;
    plannerError = "";
    published = false;
    try {
      const result = await window.phaseatlas.planning.start(selectedCheckoutId, {
        target: planningTarget(),
        runnerId: plannerRunnerId,
        request: plannerRequest.trim(),
        ...(plannerModel.trim() ? { model: plannerModel.trim() } : {}),
        ...(plannerReasoningEffort ? { reasoningEffort: plannerReasoningEffort } : {}),
      });
      if (!planningRunId) planningRunId = result.runId;
    } catch (error) {
      planningStatus = "failed";
      plannerError = error instanceof Error ? error.message : "The planning run could not be started.";
    }
  }

  async function cancelPlanning() {
    if (!window.phaseatlas || !planningRunId) return;
    await window.phaseatlas.planning.cancel(selectedCheckoutId, planningRunId);
  }

  function updateSuggestedPaths(index: number, value: string) {
    if (!proposals) return;
    proposals = {
      workspaces: proposals.workspaces,
      tasks: proposals.tasks.map((task, taskIndex) => taskIndex === index
        ? { ...task, suggestedPaths: value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean) }
        : task),
    };
  }

  function removeProposal(index: number) {
    if (!proposals) return;
    proposals = {
      workspaces: proposals.workspaces,
      tasks: proposals.tasks.filter((_task, taskIndex) => taskIndex !== index),
    };
  }

  function updateWorkspaceSlug(value: string) {
    if (!proposals?.workspaces[0]) return;
    const slug = value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-/, "");
    proposals = {
      workspaces: [{ ...proposals.workspaces[0], slug }],
      tasks: proposals.tasks.map((task) => ({ ...task, workspaceSlug: slug })),
    };
  }

  async function publishProposals() {
    if (!window.phaseatlas || !proposals?.tasks.length || publishing) return;
    publishing = true;
    plannerError = "";
    const existingKeys = new Set((taskSnapshot?.tasks ?? []).map(canonicalTaskKey));
    const createdWorkspaceSlug = proposals.workspaces[0]?.slug;
    try {
      taskSnapshot = await window.phaseatlas.planning.publish(
        selectedCheckoutId,
        { target: planningTarget(), proposals },
      );
      const publishedTask = taskSnapshot.tasks.find((task) => !existingKeys.has(canonicalTaskKey(task)));
      if (publishedTask) selectedTaskKey = canonicalTaskKey(publishedTask);
      const repository = await window.phaseatlas.repositories.refresh(selectedCheckoutId);
      repositories = repositories.map((item) => item.checkoutId === selectedCheckoutId ? repository : item);
      workspaces = await window.phaseatlas.workspaces.list(selectedCheckoutId);
      if (createdWorkspaceSlug) selectWorkspace(createdWorkspaceSlug, publishedTask ? canonicalTaskKey(publishedTask) : "");
      published = true;
    } catch (error) {
      plannerError = error instanceof Error ? error.message : "The proposals could not be published.";
    } finally {
      publishing = false;
    }
  }

  async function closeRepository(event: MouseEvent, checkoutId: string) {
    event.stopPropagation();
    if (!window.phaseatlas) return;
    await window.phaseatlas.repositories.close(checkoutId);
    repositories = repositories.filter((repository) => repository.checkoutId !== checkoutId);
    removeRepositoryWorkbenchState(checkoutId);
    if (selectedCheckoutId === checkoutId) {
      repositoryLoadRequest += 1;
      repositoryLoading = false;
      selectedCheckoutId = "";
      workspaces = [];
      runners = [];
      taskSnapshot = null;
      selectedWorkspaceSlug = "";
      selectedTaskKey = "";
      chatOpen = false;
      executionOpen = false;
      agentRuns = [];
      agentEvents = {};
      agentEventCursors = {};
      terminalMaximized = false;
      if (repositories[0]) await selectRepository(repositories[0].checkoutId);
      else {
        terminalOpen = false;
        editorOpen = false;
        clearWorkbenchState();
      }
    }
  }

  function setTheme(nextTheme: "light" | "dark") {
    theme = nextTheme;
    document.documentElement.dataset.theme = nextTheme;
    localStorage.setItem("phaseatlas-theme", nextTheme);
  }

  function closeCurrentSurface() {
    if (terminalOpen && terminalPanel?.hasFocus()) {
      void closeTerminal();
    } else if (editorOpen) {
      repositoryWorkbench?.closeActiveSurface();
    } else if (chatOpen) {
      chatOpen = false;
    } else if (executionConfirmAction) {
      executionConfirmAction = null;
      executionScopeConfirmed = false;
      executionPanelElement?.focus();
    } else if (executionOpen) {
      closeExecutionWorkbench();
    } else if (contentPanelTask) {
      taskContentPanel?.closeActiveSurface();
    } else if (plannerOpen) {
      closePlanner();
    } else if (terminalOpen) {
      void closeTerminal(false);
    } else {
      menuOpen = false;
    }
  }

  function handleWindowKeydown(event: KeyboardEvent) {
    if (event.key === "Tab" && executionOpen && executionPanelElement) {
      const focusable = [...executionPanelElement.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
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
    const chatShortcut = event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === "l";
    if (chatShortcut && !event.repeat && selectedCheckoutId) {
      if (!editorOpen && (chatOpen || (!executionOpen && !plannerOpen && !contentPanelTask))) {
        event.preventDefault();
        chatOpen = !chatOpen;
      }
      return;
    }
    const modifier = event.metaKey || event.ctrlKey;
    const closeShortcut = modifier && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "w";
    if (closeShortcut) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) closeCurrentSurface();
      return;
    }
    const explorerShortcut = modifier && event.shiftKey && !event.altKey && event.code === "KeyE";
    if (explorerShortcut) {
      event.preventDefault();
      if (
        !event.repeat &&
        selectedCheckoutId &&
        !chatActive &&
        !executionOpen &&
        !plannerOpen &&
        !contentPanelTask
      ) openRepositoryEditor();
      return;
    }
    const terminalShortcut = modifier && !event.shiftKey && !event.altKey && (
      event.code === "Backquote" || event.key.toLowerCase() === "j"
    );
    if (terminalShortcut && !event.repeat && selectedCheckoutId) {
      event.preventDefault();
      void toggleTerminal();
      return;
    }
    if (event.key !== "Escape") return;
    if (terminalOpen && terminalPanel?.hasFocus()) return;
    if (editorOpen) return;
    if (chatOpen) chatOpen = false;
    else if (executionConfirmAction) {
      executionConfirmAction = null;
      executionScopeConfirmed = false;
      executionPanelElement?.focus();
    }
    else if (executionOpen) closeExecutionWorkbench();
    else if (terminalMaximized) terminalMaximized = false;
    else if (plannerOpen) closePlanner();
    else menuOpen = false;
  }
</script>

<svelte:head>
  <title>PhaseAtlas · KétViệt</title>
  <meta
    name="description"
    content="KétViệt's repository-oriented control center for tasks and agents."
  />
</svelte:head>

<svelte:window onkeydown={handleWindowKeydown} />

<a class="skip-link" href="#main-content">Skip to main content</a>

<div class="app-shell">
  <aside class:mobile-open={menuOpen} class="sidebar" aria-label="Repository navigation">
    <div class="brand-lockup">
      <img class="product-mark" src={theme === "dark" ? "./assets/phaseatlas-logo-mark-dark.png" : "./assets/phaseatlas-logo-mark.png"} width="1254" height="1254" alt="" />
      <span class="product-name"><strong>PhaseAtlas</strong><small>Unify AI Tool</small></span>
    </div>

    <div class="sidebar-section-heading">
      <span>Repositories</span>
      <strong>{repositories.length}</strong>
    </div>

    <button class="primary-button open-repository" type="button" onclick={openRepository} disabled={opening}>
      <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      <span>{opening ? "Opening…" : "Open repository"}</span>
    </button>

    <nav class="repository-list" aria-label="Open repositories">
      {#each repositories as repository}
        <div class:active={repository.checkoutId === selectedCheckoutId} class="repository-row">
          <button class="repository-select" type="button" onclick={() => selectRepository(repository.checkoutId)}>
            <span class="repository-copy">
              <strong>{repository.name}</strong>
              <small>{repository.workspaceCount} {repository.workspaceCount === 1 ? "workspace" : "workspaces"}</small>
            </span>
            <span class="online-dot" aria-label="Worker is online"></span>
          </button>
          <button class="repository-close" type="button" aria-label={`Close ${repository.name}`} onclick={(event) => closeRepository(event, repository.checkoutId)}>
            <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>
          </button>
        </div>
      {/each}
    </nav>

    <footer class="sidebar-footer">
      <span class="live-indicator"></span>
      <span><strong>Local runtime</strong><small>One worker per checkout</small></span>
    </footer>
  </aside>

  <header class="mobile-topbar">
    <div class="mobile-brand">
      <img class="product-mark" src={theme === "dark" ? "./assets/phaseatlas-logo-mark-dark.png" : "./assets/phaseatlas-logo-mark.png"} width="1254" height="1254" alt="" />
      <span class="product-name"><strong>PhaseAtlas</strong><small>Unify AI Tool</small></span>
    </div>
    <button class="icon-button" type="button" aria-label={menuOpen ? "Close menu" : "Open menu"} aria-expanded={menuOpen} onclick={() => (menuOpen = !menuOpen)}>
      <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">{#if menuOpen}<path d="m6 6 12 12M18 6 6 18"/>{:else}<path d="M4 7h16M4 12h16M4 17h16"/>{/if}</svg>
    </button>
  </header>
  {#if menuOpen}<button class="sidebar-backdrop" type="button" aria-label="Close menu" onclick={() => (menuOpen = false)}></button>{/if}

  <main
    class:terminal-visible={terminalOpen && !editorOpen && Boolean(selectedCheckoutId) && !terminalMaximized}
    class="main"
    id="main-content"
    style={`--terminal-panel-height: ${terminalHeight}px`}
  >
    <header class="command-bar">
      <div class="breadcrumbs">
        <span>PhaseAtlas</span><span>/</span><strong>{selectedRepository?.name || "Repositories"}</strong>
      </div>
      <div class="command-actions">
        <button
          class:active={chatActive}
          class="terminal-toggle"
          type="button"
          aria-label={`${chatActive ? "Close" : "Open"} repository agent chat`}
          aria-pressed={chatActive}
          title={`Toggle agent chat (${chatShortcutLabel})`}
          onclick={() => chatOpen = !chatOpen}
          disabled={!selectedCheckoutId}
        >
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v10H9l-4 4z"/><path d="M9 9h6M9 12h4"/></svg>
          <span>Chat</span>
          <kbd>{chatShortcutLabel}</kbd>
        </button>
        <button
          class:active={editorOpen}
          class="terminal-toggle"
          type="button"
          aria-label="Open repository explorer"
          aria-pressed={editorOpen}
          title={`Open explorer (${explorerShortcutLabel})`}
          onclick={() => openRepositoryEditor()}
          disabled={!selectedCheckoutId}
        >
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4zM8 5v14M11 9h6M11 13h4"/></svg>
          <span>Explorer</span>
          <kbd>{explorerShortcutLabel}</kbd>
        </button>
        <button
          class:active={terminalOpen}
          class="terminal-toggle"
          type="button"
          aria-label={`${terminalOpen ? "Close" : "Open"} repository terminal`}
          aria-pressed={terminalOpen}
          title={`Toggle terminal (${terminalShortcutLabel})`}
          onclick={toggleTerminal}
          disabled={!selectedCheckoutId}
        >
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 7 4.5 5L5 17M12 17h7"/></svg>
          <span>Terminal</span>
          <kbd>{terminalShortcutLabel}</kbd>
        </button>
        <span class="runtime-badge"><span class="live-indicator"></span>{platform} · local</span>
        <button class="theme-toggle" type="button" aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} aria-pressed={theme === "dark"} onclick={() => setTheme(theme === "dark" ? "light" : "dark")}>
          <span class="theme-track"><span class="theme-thumb"></span></span>
          <span>{theme === "dark" ? "Dark" : "Light"}</span>
        </button>
      </div>
    </header>

    <div class="content">
      {#if loading}
        <section class="card loading-state" aria-live="polite">
          <span class="loading-mark"></span>
          <div><h1>Initializing PhaseAtlas</h1><p>Checking the desktop bridge and repository worker…</p></div>
        </section>
      {:else if selectedRepository}
        <section class="card repository-toolbar" aria-label="Active repository">
          <div class="repository-summary">
            <span class="repository-mark" aria-hidden="true">
              <svg class="icon" viewBox="0 0 24 24"><path d="M3 7.5h7l2-2h9v13H3z"/><path d="M3 9.5h18"/></svg>
            </span>
            <div class="repository-copy">
              <p class="eyebrow">Active repository</p>
              <div class="repository-title-line">
                <h1>{selectedRepository.name}</h1>
                <span class="repository-state"><span></span>{selectedRepository.configuration === "configured" ? "Configured" : "Legacy"}</span>
              </div>
              <p class="repository-path"><span>{selectedRepository.path}</span><span aria-hidden="true">·</span><span>Checkout {selectedRepository.checkoutId.slice(0, 8).toUpperCase()}</span></p>
            </div>
          </div>
          <div class="repository-toolbar-actions">
            <button class="secondary-button" type="button" onclick={() => openExecutionWorkbench()}>
              <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v16H5zM8 8h8M8 12h5M8 16h7"/><path d="m15 11 4 2.5-4 2.5z"/></svg>
              Runs
            </button>
            <div class:unavailable={!providerSelectionReady} class="provider-quick-controls" bind:this={agentConfigurationElement}>
              <span class="provider-quick-status" aria-hidden="true"></span>
              <label>
                <span class="sr-only">Agent CLI</span>
                <select value={plannerRunnerId} onchange={(event) => selectProviderRunner(event.currentTarget.value)} aria-label="Agent CLI" title="Agent CLI">
                  {#each runners as runner}
                    <option value={runner.id} disabled={!runner.available}>{runner.name}</option>
                  {/each}
                </select>
              </label>
              <label class="provider-quick-model">
                <span class="sr-only">Model</span>
                <select value={plannerModel} onchange={(event) => selectProviderModel(event.currentTarget.value)} disabled={!selectedModels.length} aria-label="Model" title="Model">
                  {#each selectedModels as model}
                    <option value={model.id}>{model.displayName}{model.isDefault ? " · default" : ""}</option>
                  {/each}
                </select>
              </label>
              <label class="provider-quick-effort">
                <span class="sr-only">Reasoning effort</span>
                <select
                  value={plannerReasoningEffort}
                  onchange={(event) => selectProviderReasoningEffort(event.currentTarget.value)}
                  disabled={!reasoningEffortSupported}
                  aria-label="Reasoning effort"
                  title={reasoningEffortSupported
                    ? "Reasoning effort"
                    : `${selectedProviderModel?.displayName ?? "This model"} does not expose reasoning effort`}
                >
                  {#if reasoningEffortSupported}
                    <option value="">Provider default</option>
                    {#each selectedReasoningEfforts as effort}
                      <option value={effort}>{effort}{effort === selectedProviderModel?.defaultReasoningEffort ? " · default" : ""}</option>
                    {/each}
                  {:else}
                    <option value="">No effort control</option>
                  {/if}
                </select>
              </label>
            </div>
            <button class="secondary-button" type="button" onclick={() => openPlanner("repository")}>
              <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="7" height="7" rx="1"/><rect x="14" y="4" width="7" height="7" rx="1"/><rect x="3" y="15" width="7" height="6" rx="1"/><path d="M14 18h7M17.5 14.5v7"/></svg>
              Plan workspace
            </button>
            <button class="secondary-button" type="button" onclick={() => openPlanner("workspace")} disabled={!selectedWorkspaceSlug}>
              <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/><circle cx="12" cy="12" r="3"/></svg>
              Plan tasks
            </button>
          </div>
        </section>

        {#if errorMessage}
          <div class="alert warning" role="alert"><span aria-hidden="true">!</span><div><strong>Unable to complete the action</strong><p>{errorMessage}</p></div></div>
        {/if}

        <section class="workspace-section">
          {#if repositoryLoading}
            <div class="card loading-state repository-loading-state" aria-live="polite" aria-busy="true">
              <span class="loading-mark" aria-hidden="true"></span>
              <div><h2>Loading repository</h2><p>Reading workspaces and canonical tasks for {selectedRepository.name}…</p></div>
            </div>
          {:else if workspaces.length}
            {#if selectedWorkspace}
              <div class="card workspace-switcher">
                <span class="workspace-switcher-icon" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24"><rect x="3" y="4" width="7" height="7" rx="1"/><rect x="14" y="4" width="7" height="7" rx="1"/><rect x="3" y="15" width="7" height="6" rx="1"/><path d="M14 18h7M17.5 14.5v7"/></svg></span>
                <div class="workspace-switcher-copy">
                  <p><span>Workspace</span><code>{selectedWorkspace.slug}</code></p>
                  <strong>{selectedWorkspace.name}</strong>
                </div>
                <span class="workspace-task-count"><strong>{selectedWorkspace.taskCount}</strong>{selectedWorkspace.taskCount === 1 ? "task" : "tasks"}</span>
                <label class="workspace-select">
                  <span>Switch workspace</span>
                  <select value={selectedWorkspaceSlug} onchange={(event) => selectWorkspace(event.currentTarget.value)} aria-label="Switch workspace">
                    {#each workspaces as workspace}
                      <option value={workspace.slug}>{workspace.name} · {workspace.taskCount}</option>
                    {/each}
                  </select>
                  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 5 5-5"/></svg>
                </label>
                <div class="task-view-tabs" role="tablist" aria-label="Task view">
                  <button type="button" role="tab" aria-selected={taskView === "list"} tabindex={taskView === "list" ? 0 : -1} onclick={() => setTaskView("list")} onkeydown={(event) => moveTaskView(event, 0)}>
                    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg>
                    List
                  </button>
                  <button type="button" role="tab" aria-selected={taskView === "map"} tabindex={taskView === "map" ? 0 : -1} onclick={() => setTaskView("map")} onkeydown={(event) => moveTaskView(event, 1)}>
                    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="6" height="6" rx="1"/><rect x="15" y="4" width="6" height="6" rx="1"/><rect x="9" y="14" width="6" height="6" rx="1"/><path d="M9 7h6M12 10v4"/></svg>
                    Map
                  </button>
                </div>
              </div>
            {/if}

            {#if taskSnapshot?.issues.length}
              <section class="card validation-console" aria-label="Canonical task validation issues">
                <header>
                  <span class="validation-icon" aria-hidden="true">!</span>
                  <div><p class="eyebrow">Contract validation</p><h3>{taskSnapshot.issues.length} {(taskSnapshot.issues.length === 1) ? "issue requires" : "issues require"} attention</h3></div>
                  {#if taskSnapshot.graph.hasCycles}<span class="cycle-badge">Cycle detected</span>{/if}
                </header>
                <div class="validation-list">
                  {#each taskSnapshot.issues as issue}
                    <article class="validation-row">
                      <span class:warning={issue.severity === "warning"} class="severity-dot"></span>
                      <div><strong>{issue.code}</strong><p>{issue.message}</p><small>{issue.sourcePath}{issue.field ? ` · ${issue.field}` : ""}</small></div>
                    </article>
                  {/each}
                </div>
              </section>
            {/if}

            {#if selectedWorkspace}
              <section class="task-view-surface" aria-label={`${selectedWorkspace.name} task views`}>
                {#if taskView === "map"}
                  <TaskMap tasks={workspaceTasks} {selectedTaskKey} initializingTaskKeys={[...activeContentTaskKeys]} onSelect={selectTask} onOpenDetails={openTaskDetails} />
                {:else}
              <div class="task-workbench">
                <aside class="card task-queue" aria-label={`${selectedWorkspace.name} tasks`}>
                  <header class="task-queue-header">
                    <div><p class="eyebrow">{selectedWorkspace.slug}</p><h3>Tasks</h3></div>
                    <div class="task-queue-actions">
                      {#if missingContentTasks.length}
                        <button type="button" onclick={() => initializeTaskContent(availableContentTasks.map(canonicalTaskKey))} disabled={!availableContentTasks.length || !providerSelectionReady} title="Initialize every task body that is not already running">Initialize {availableContentTasks.length}</button>
                      {/if}
                      <span>{workspaceTasks.length}</span>
                    </div>
                  </header>
                  {#if workspaceTasks.length}
                    <div class="task-list">
                      {#each workspaceTasks as task}
                        <button class:active={canonicalTaskKey(task) === canonicalTaskKey(selectedTask ?? task)} class:initializing={activeContentTaskKeys.has(canonicalTaskKey(task))} class="task-row" type="button" aria-busy={activeContentTaskKeys.has(canonicalTaskKey(task))} onclick={() => selectTask(task)}>
                          <span class="task-state-dot" data-state={task.state}></span>
                          <span class="task-row-copy"><small>{task.key.taskId} · {task.kind}</small><strong>{task.title}</strong><span>{activeContentTaskKeys.has(canonicalTaskKey(task)) ? "Initializing content…" : `${stateLabel(task.state)} · ${task.priority}`}</span></span>
                          {#if activeContentTaskKeys.has(canonicalTaskKey(task))}
                            <span class="task-content-spinner" role="status" aria-label="Initializing task content"></span>
                          {:else}
                            <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
                          {/if}
                        </button>
                      {/each}
                    </div>
                  {:else}
                    <div class="task-queue-empty"><strong>No canonical tasks</strong><p>Add a valid YAML task file to this workspace.</p></div>
                  {/if}
                </aside>

                <section class="card task-detail" aria-live="polite">
                  {#if selectedTask}
                    <header class="task-detail-header">
                      <div>
                        <div class="task-identity"><span>{selectedTask.key.taskId}</span><code>{selectedTask.revision.slice(0, 10)}</code></div>
                        <h2>{selectedTask.title}</h2>
                        <p>{selectedTask.objective}</p>
                      </div>
                      <div class="task-header-actions">
                        <div class="task-badges"><span class="state-badge" data-state={selectedTask.state}>{stateLabel(selectedTask.state)}</span><span class="priority-badge" data-priority={selectedTask.priority}>{selectedTask.priority}</span></div>
                      </div>
                    </header>

                    <div class="task-detail-grid">
                      <section class="detail-block">
                        <p class="detail-label">Ownership</p>
                        <div class="owner-list">{#each selectedTask.owners as owner}<span>{owner}</span>{/each}</div>
                      </section>
                      <section class="detail-block">
                        <p class="detail-label">Phase & kind</p>
                        <p class="detail-value">{selectedTask.phaseId} <span>·</span> {selectedTask.kind}</p>
                      </section>
                      <section class="detail-block full-span">
                        <p class="detail-label">Dependencies</p>
                        {#if selectedTask.dependencies.length}<div class="dependency-list">{#each selectedTask.dependencies as dependency}<span><strong>{dependency.taskKey}</strong>{dependency.relation.replaceAll("_", " ")}</span>{/each}</div>{:else}<p class="muted-value">No declared dependencies.</p>{/if}
                      </section>
                      <section class="detail-block full-span">
                        <p class="detail-label">Allowed scope</p>
                        <div class="path-list">{#each selectedTask.scope.allowedPaths as allowedPath}<code>{allowedPath}</code>{/each}</div>
                      </section>
                    </div>

                    <section class:initialized={Boolean(selectedTask.content)} class="task-content-card">
                      <header>
                        <div>
                          <p class="detail-label">Task body</p>
                          <h3>{selectedTask.content ? "Implementation context initialized" : "Content not initialized"}</h3>
                        </div>
                        <span>{selectedTask.content ? "Markdown" : "Optional"}</span>
                      </header>
                      {#if selectedTask.content}
                        <p class="task-content-preview">{selectedTask.content.body.slice(0, 280)}{selectedTask.content.body.length > 280 ? "…" : ""}</p>
                        <footer>
                          <code>{selectedTask.content.path}</code>
                          <button class="secondary-button" type="button" onclick={() => openRepositoryEditor(selectedTask.content?.path)}>Edit in Monaco</button>
                        </footer>
                      {:else}
                        <p>Generate a repository-aware Markdown body when this task is ready for implementation. Publishing the outline does not spend these tokens.</p>
                        <button class="primary-button" type="button" onclick={() => initializeTaskContent([canonicalTaskKey(selectedTask)], true)} disabled={activeContentTaskKeys.has(canonicalTaskKey(selectedTask)) || !providerSelectionReady}>
                          {activeContentTaskKeys.has(canonicalTaskKey(selectedTask)) ? "Initializing…" : "Initialize task content"}
                        </button>
                      {/if}
                      {#if contentLogs[canonicalTaskKey(selectedTask)] || contentFailures[canonicalTaskKey(selectedTask)]}
                        <div class="task-content-stream" data-status={contentFailures[canonicalTaskKey(selectedTask)] ? "failed" : contentTaskStatuses[canonicalTaskKey(selectedTask)]}>
                          <header><span></span><strong>{contentFailures[canonicalTaskKey(selectedTask)] ? "Content agent failed" : "Content agent stream"}</strong></header>
                          <pre>{contentFailures[canonicalTaskKey(selectedTask)] ?? contentLogs[canonicalTaskKey(selectedTask)]}</pre>
                        </div>
                      {/if}
                    </section>

                    <section class="detail-section">
                      <header><div><p class="detail-label">Acceptance criteria</p><h3>Definition of done</h3></div><span>{selectedTask.acceptanceCriteria.length}</span></header>
                      <ol class="criteria-list">
                        {#each selectedTask.acceptanceCriteria as criterion}
                          <li><span class="criterion-id">{criterion.id}</span><p>{criterion.statement}</p><small>{criterion.verification.type}</small></li>
                        {/each}
                      </ol>
                    </section>

                    <section class="detail-section verification-section">
                      <header><div><p class="detail-label">Verification</p><h3>Required checks</h3></div><span>{selectedTask.verification.length}</span></header>
                      <div class="verification-list">
                        {#each selectedTask.verification as step}
                          <article><div><strong>{step.id}</strong>{#if step.required}<span>required</span>{/if}</div><code>{step.command}</code><small>{step.timeoutSeconds}s timeout{step.cwd ? ` · ${step.cwd}` : ""}</small></article>
                        {/each}
                      </div>
                    </section>

                    <footer class="task-source"><span>Source of truth</span><code>{selectedTask.source.documents[0]?.path}</code></footer>
                  {:else}
                    <div class="task-detail-empty"><span class="workspace-icon" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24"><path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5"/></svg></span><h2>Select a canonical task</h2><p>Task details and execution constraints will appear here.</p></div>
                  {/if}
                </section>
              </div>
                {/if}
              </section>
            {/if}
          {:else if !errorMessage}
            <div class="card empty-state">
              <img src={theme === "dark" ? "./assets/phaseatlas-logo-mark-dark.png" : "./assets/phaseatlas-logo-mark.png"} width="1254" height="1254" alt="" aria-hidden="true" />
              <div><h2>This repository has no workspaces</h2><p>Let a read-only runner inspect the repository and propose its first workspace with starter tasks.</p><button class="primary-button empty-state-action" type="button" onclick={() => openPlanner("repository")}>Plan first workspace</button></div>
            </div>
          {/if}
        </section>
      {:else}
        <section class="welcome-state">
          <div class="welcome-copy">
            <p class="eyebrow">PhaseAtlas desktop</p>
            <h1>Open a repository to get started</h1>
            <p>PhaseAtlas creates an isolated backend process, reads the workspaces, and prepares a safe scope for tasks and agent runs.</p>
            <button class="primary-button welcome-action" type="button" onclick={openRepository}>
              <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h6l2 2h10v10H3z"/><path d="M12 12v5M9.5 14.5h5"/></svg>
              Select repository
            </button>
          </div>
          <aside class="card next-step-card">
            <p class="eyebrow">Next safe step</p>
            <h2>Select a Git checkout</h2>
            <ol><li><span>01</span>Verify the repository manifest</li><li><span>02</span>Start the utility worker</li><li><span>03</span>Index the workspaces</li></ol>
          </aside>
          {#if errorMessage}<div class="alert warning welcome-error" role="alert"><span aria-hidden="true">!</span><div><strong>Unable to initialize</strong><p>{errorMessage}</p></div></div>{/if}
        </section>
      {/if}
    </div>
  </main>
</div>

{#if executionOpen}
  <button class="execution-backdrop" type="button" aria-label="Close execution workbench" onclick={closeExecutionWorkbench}></button>
  <div
    class:terminal-docked={terminalOpen && !terminalMaximized}
    class="execution-panel"
    role="dialog"
    aria-modal="true"
    aria-labelledby="execution-title"
    tabindex="-1"
    bind:this={executionPanelElement}
    style={`--persistent-terminal-height: ${terminalHeight}px`}
  >
    <header class="execution-header">
      <div class="execution-header-mark" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24"><path d="M5 4h14v16H5zM8 8h8M8 12h5M8 16h7"/><path d="m15 11 4 2.5-4 2.5z"/></svg></div>
      <div>
        <p class="eyebrow">Durable execution</p>
        <h2 id="execution-title">Run workbench</h2>
        <p>{selectedRepository?.name} · persisted events remain available after restart</p>
      </div>
      <button class="icon-button" type="button" aria-label="Close execution workbench" onclick={closeExecutionWorkbench}>
        <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>
      </button>
    </header>

    <div class="execution-layout">
      <aside class="execution-history" aria-label="Agent run history">
        <header>
          <div><p class="eyebrow">Repository history</p><h3>{agentRuns.length} {agentRuns.length === 1 ? "run" : "runs"}</h3></div>
          <button class="run-refresh-button" type="button" aria-label="Refresh run history" onclick={() => loadAgentRuns(selectedAgentRunId)}>
            <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/></svg>
          </button>
        </header>
        {#if agentRuns.length}
          <div class="execution-history-list">
            {#each agentRuns as run}
              <button class:active={run.runId === selectedAgentRunId} class="execution-history-row" type="button" onclick={() => selectAgentRun(run.runId)}>
                <span class="run-status-orbit" data-status={run.status}><i></i></span>
                <span class="execution-history-copy">
                  <small>{run.taskKey} · {actionLabel(run.action)}</small>
                  <strong>{run.status.replaceAll("_", " ")}</strong>
                  <span>{formatRunTime(run.updatedAt)} · {run.runnerId}</span>
                </span>
                {#if run.freshness === "stale"}<span class="run-freshness-chip stale">stale</span>{/if}
              </button>
            {/each}
          </div>
        {:else}
          <div class="execution-history-empty"><strong>No task runs yet</strong><p>Choose an available action to create the first durable attempt.</p></div>
        {/if}
      </aside>

      <div class="execution-main">
        {#if selectedTask}
          <section class="execution-launchpad" aria-labelledby="execution-task-title">
            <header>
              <div><p class="eyebrow">Selected task</p><h3 id="execution-task-title">{selectedTask.key.taskId} · {selectedTask.title}</h3><p>{selectedTask.objective}</p></div>
              <code>{selectedTask.revision.slice(0, 10)}</code>
            </header>
            <div class="pipeline-provider">
              <span>Agent</span>
              <ProviderPicker
                {runners}
                runnerId={plannerRunnerId}
                modelId={plannerModel}
                reasoningEffort={plannerReasoningEffort}
                disabled={Boolean(executionStartingAction)}
                placement="down"
                onSelect={applyProviderSelection}
              />
              <small>Applies to this run and to every repository selection</small>
            </div>
            <ol class="pipeline" aria-busy={executionActionsLoading} aria-label="Task run pipeline">
              {#if executionActionsLoading}
                <li class="execution-actions-loading"><span class="task-content-spinner"></span>Evaluating provider and task policy…</li>
              {:else}
                {#each pipelineStages as stage, index}
                  <li class="pipeline-stage" data-state={stage.state}>
                    {#if index > 0}<span class="pipeline-arrow" aria-hidden="true"></span>{/if}
                    <button
                      class="pipeline-node"
                      type="button"
                      disabled={!stage.availability.available || Boolean(executionStartingAction)}
                      aria-label={`${actionLabel(stage.action)} — ${stage.stateLabel}`}
                      title={stage.availability.blockingReasons.join(" ") || stage.stateLabel}
                      onclick={() => requestAgentAction(stage.availability)}
                    >
                      <span class="pipeline-mark" aria-hidden="true">
                        {#if stage.state === "done"}
                          <svg viewBox="0 0 24 24"><path d="m5 13 4 4 10-10"/></svg>
                        {:else if stage.state === "running"}
                          <span class="task-content-spinner"></span>
                        {:else if stage.state === "blocked"}
                          <svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="1"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>
                        {:else}
                          <span class="pipeline-index">{index + 1}</span>
                        {/if}
                      </span>
                      <span class="pipeline-copy">
                        <strong>{executionStartingAction === stage.action ? "Starting…" : actionLabel(stage.action)}</strong>
                        <small>{stage.stateLabel}</small>
                      </span>
                    </button>
                    {#if stage.isEntry}<span class="pipeline-entry">Start here</span>{/if}
                  </li>
                {/each}
              {/if}
            </ol>
            {#if pipelineBlocker}
              <p class="execution-action-reason"><strong>Blocked:</strong> {pipelineBlocker}</p>
            {/if}
          </section>
          <div class="execution-journal">
            <TaskConversation
              checkoutId={selectedCheckoutId}
              taskKey={canonicalTaskKey(selectedTask)}
              runnerId={plannerRunnerId}
              modelId={plannerModel}
              reasoningEffort={plannerReasoningEffort}
              runs={pipelineRuns}
              runEvents={agentEvents}
              providerReady={providerSelectionReady}
              onOpenPath={openRepositoryPathInEditor}
            />
          </div>
        {/if}

        {#if executionConfirmAction && selectedTask}
          <div class="execution-confirm" role="alertdialog" aria-labelledby="execution-confirm-title" tabindex="-1" bind:this={executionConfirmElement}>
            <header><span aria-hidden="true">!</span><div><p class="eyebrow">Write boundary</p><h3 id="execution-confirm-title">Confirm isolated implementation</h3></div></header>
            <p>The provider will write only inside a PhaseAtlas-owned worktree. The canonical checkout and task state remain unchanged until a separate review.</p>
            <dl>
              <div><dt>Repository</dt><dd>{selectedRepository?.name}</dd></div>
              <div><dt>Provider</dt><dd>{selectedRunner?.name} · {selectedProviderModel?.displayName}{plannerReasoningEffort ? ` · ${plannerReasoningEffort} effort` : reasoningEffortSupported ? " · default effort" : ""}</dd></div>
              <div><dt>Sandbox</dt><dd>{executionConfirmAction.sandbox}</dd></div>
              <div><dt>Network</dt><dd>{selectedTask.scope.allowExternalNetwork ? "Allowed by task" : "Blocked"}</dd></div>
            </dl>
            <div class="execution-confirm-scope"><span>Writable scope</span>{#each selectedTask.scope.allowedPaths as allowedPath}<code>{allowedPath}</code>{/each}</div>
            <label class="execution-confirm-check"><input type="checkbox" bind:checked={executionScopeConfirmed} /><span>I reviewed the task revision, provider, sandbox, and writable scope.</span></label>
            <footer><button class="secondary-button" type="button" onclick={() => executionConfirmAction = null}>Back</button><button class="primary-button" type="button" disabled={!executionScopeConfirmed || Boolean(executionStartingAction)} onclick={() => executionConfirmAction && startAgentRun(executionConfirmAction)}>Start isolated run</button></footer>
          </div>
        {/if}

        {#if executionError}<div class="execution-message error" role="alert"><strong>Execution needs attention</strong><span>{executionError}</span></div>{/if}
        {#if executionNotice}<div class="execution-message" role="status"><span class="live-indicator"></span><span>{executionNotice}</span></div>{/if}

        {#if selectedAgentRun}
          <section class="execution-run" aria-labelledby="selected-run-title">
            <header class="execution-run-header">
              <div>
                <div class="execution-run-kicker"><span class="run-status-orbit" data-status={selectedAgentRun.status}><i></i></span><span>{selectedAgentRun.status.replaceAll("_", " ")}</span><code>{selectedAgentRun.runId.slice(0, 8)}</code></div>
                <h3 id="selected-run-title">{actionLabel(selectedAgentRun.action)} · {selectedAgentRun.taskKey}</h3>
                <p>{selectedAgentRun.runnerId}{selectedAgentRun.model ? ` / ${selectedAgentRun.model}` : ""}{selectedAgentRun.reasoningEffort ? ` / ${selectedAgentRun.reasoningEffort} effort` : ""} · revision {selectedAgentRun.taskRevision.slice(0, 10)}</p>
              </div>
              <div class="execution-run-actions">
                {#if isAgentRunActive(selectedAgentRun)}
                  <button class="secondary-button danger-button" type="button" disabled={Boolean(cancellingAgentRunId)} onclick={() => cancelAgentRun(selectedAgentRun.runId)}>{cancellingAgentRunId ? "Stopping provider…" : "Cancel run"}</button>
                {:else if selectedAgentRun.status === "interrupted"}
                  <button class="secondary-button" type="button" disabled={Boolean(recoveringAgentRunId)} onclick={() => recoverAgentRun(selectedAgentRun.runId, "leave_interrupted")}>Keep as history</button>
                  <button class="primary-button" type="button" disabled={Boolean(recoveringAgentRunId) || !providerSelectionReady} onclick={() => recoverAgentRun(selectedAgentRun.runId, "retry")}>Retry current task</button>
                {/if}
              </div>
            </header>

            <div class="execution-run-meta">
              <span><small>Started</small>{formatRunTime(selectedAgentRun.createdAt)}</span>
              <span><small>Sandbox</small>{selectedAgentRun.sandbox}</span>
              <span><small>Events</small>{selectedAgentEvents.length}</span>
              <span><small>Freshness</small>{selectedAgentRun.freshness ?? "pending"}</span>
            </div>


            {#if selectedAgentReview}
              <section class="execution-result" data-freshness={selectedAgentReview.freshness}>
                <header>
                  <div><p class="eyebrow">Validated result</p><h3>{selectedTask ? `${selectedTask.key.taskId} · ${actionLabel(selectedAgentRun?.action ?? "analyze")}` : "Summary"}</h3></div>
                  <span class="result-freshness">{selectedAgentReview.freshness}</span>
                </header>
                <!-- The summary is prose, often several hundred words. Heading
                     typography made it a wall; it belongs in body text. -->
                <div class="execution-result-summary"><ModelMarkdown source={selectedAgentReview.persisted.validated.result.summary} onOpenPath={openRepositoryPathInEditor} /></div>
                {#if selectedAgentReview.reason}<p class="execution-result-warning">{selectedAgentReview.reason}</p>{/if}
                <div class="execution-result-grid">
                  <section><span>Outcome</span><strong>{selectedAgentReview.persisted.validated.result.outcome}</strong><small>{selectedAgentReview.promotable ? "Eligible for separate promotion review" : "Not promotable"}</small></section>
                  <section><span>Next action</span><strong><ModelMarkdown source={selectedAgentReview.persisted.validated.result.nextAction} onOpenPath={openRepositoryPathInEditor} /></strong><small>{selectedAgentReview.persisted.validated.result.requiresHumanReview ? "Human review required" : "No review requested"}</small></section>
                </div>
                <div class="execution-result-columns">
                  <section>
                    <header><strong>Changed files</strong><span>{selectedAgentReview.persisted.validated.inspectedChanges.length}</span></header>
                    {#if selectedAgentReview.persisted.validated.inspectedChanges.length}
                      <ul class="execution-file-list">{#each selectedAgentReview.persisted.validated.inspectedChanges as change}<li><span data-change={change.changeType}>{change.changeType.slice(0, 1).toUpperCase()}</span><code>{change.path}</code>{#if change.policyViolations.length}<small>{change.policyViolations.join(" · ")}</small>{/if}</li>{/each}</ul>
                    {:else}<p class="execution-result-empty">No Git-derived changes.</p>{/if}
                  </section>
                  <section>
                    <header><strong>Verification</strong><span>{selectedAgentReview.persisted.validated.result.verification.length}</span></header>
                    {#if selectedAgentReview.persisted.validated.result.verification.length}
                      <ul class="execution-verification-list">{#each selectedAgentReview.persisted.validated.result.verification as check}<li><span data-status={check.status}></span><div><strong>{check.stepId}</strong><small><ModelMarkdown source={check.details} onOpenPath={openRepositoryPathInEditor} /></small></div></li>{/each}</ul>
                    {:else}<p class="execution-result-empty">No verification records.</p>{/if}
                  </section>
                </div>
                {#if selectedAgentReview.persisted.validated.result.producedEvidence.length}
                  <div class="execution-evidence">
                    <strong>Produced evidence</strong>
                    <ul>
                      {#each selectedAgentReview.persisted.validated.result.producedEvidence as evidence}
                        <li><span>{evidence.type.replaceAll("_", " ")}</span><ModelMarkdown source={`\`${evidence.reference}\``} onOpenPath={openRepositoryPathInEditor} /></li>
                      {/each}
                    </ul>
                  </div>
                {/if}
                {#if selectedAgentReview.persisted.validated.result.blockers.length}<div class="execution-blockers"><strong>Blockers</strong>{#each selectedAgentReview.persisted.validated.result.blockers as blocker}<p><ModelMarkdown source={blocker} onOpenPath={openRepositoryPathInEditor} /></p>{/each}</div>{/if}
              </section>
            {/if}
          </section>
        {:else}
          <div class="execution-run-empty"><span class="execution-header-mark" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24"><path d="M5 4h14v16H5zM8 8h8M8 12h5M8 16h7"/></svg></span><h3>No run selected</h3><p>Start an action or choose a durable attempt from repository history.</p></div>
        {/if}
      </div>
      {#if openedFilePath}
        <aside class="opened-file" aria-label={`File ${openedFilePath}`}>
          <header>
            <code title={openedFilePath}>{openedFilePath}</code>
            {#if openedFileIsMarkdown}
              <div class="opened-file-modes" role="group" aria-label="View mode">
                <button class:active={openedFileMode === "preview"} type="button" aria-pressed={openedFileMode === "preview"} onclick={() => openedFileMode = "preview"}>Preview</button>
                <button class:active={openedFileMode === "source"} type="button" aria-pressed={openedFileMode === "source"} onclick={() => openedFileMode = "source"}>Source</button>
              </div>
            {/if}
            <button class="opened-file-close" type="button" aria-label="Close file" onclick={closeOpenedFile}>×</button>
          </header>
          {#if openedFileLoading}
            <p class="opened-file-state">Reading {openedFilePath}…</p>
          {:else if openedFileError}
            <p class="opened-file-state">{openedFileError}</p>
          {:else if openedFileIsMarkdown && openedFileMode === "preview"}
            <div class="opened-file-preview"><ModelMarkdown source={openedFileContent} onOpenPath={openRepositoryPathInEditor} /></div>
          {:else}
            <pre>{openedFileContent}</pre>
          {/if}
        </aside>
      {/if}
    </div>
  </div>
{/if}

{#if plannerOpen}
  <button class="planner-backdrop" type="button" aria-label="Close planning studio" onclick={closePlanner}></button>
  <div class="planner-panel" role="dialog" aria-modal="true" aria-labelledby="planner-title">
    <header class="planner-header">
      <div>
        <p class="eyebrow">Read-only planning</p>
        <h2 id="planner-title">Planning studio</h2>
        <p>{plannerMode === "repository" ? `${selectedRepository?.name} · new workspace` : selectedWorkspace?.name} · proposals require review before publish</p>
      </div>
      <button class="icon-button" type="button" aria-label="Close planning studio" onclick={closePlanner} disabled={planningActive}>
        <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>
      </button>
    </header>

    <div class="planner-body">
      <section class="planner-config">
        <div class="planner-step-heading"><span>01</span><div><strong>Active agent configuration</strong><small>Change CLI, model, or effort from the always-visible repository bar.</small></div></div>
        <div class:unavailable={!providerSelectionReady} class="runner-summary">
          <span class="runner-status-dot"></span>
          <div>
            <strong>{selectedRunner?.name ?? "No runner available"} · {selectedProviderModel?.displayName ?? "No model"}</strong>
            <small>{plannerReasoningEffort ? `${plannerReasoningEffort} reasoning effort` : reasoningEffortSupported ? "Provider default reasoning effort" : "This provider does not expose reasoning effort"}</small>
          </div>
        </div>

        <div class="planner-step-heading request-heading"><span>02</span><div><strong>Describe the outcome</strong><small>The runner may inspect the repository but cannot write to it.</small></div></div>
        <div class="planning-target" data-target={plannerMode}>
          <span>{plannerMode === "repository" ? "Repository scope" : "Workspace scope"}</span>
          <strong>{plannerMode === "repository" ? "Create one workspace + starter tasks" : selectedWorkspace?.name}</strong>
          <small>{plannerMode === "repository" ? "The workspace manifest is created only after your review." : `All proposals stay inside ${selectedWorkspaceSlug}.`}</small>
        </div>
        <label class="request-field">
          <span>Planning request</span>
          <textarea bind:value={plannerRequest} rows="5" placeholder={plannerMode === "repository" ? "Example: Create a desktop workspace for the Electron runtime, renderer workflows, and local repository workers." : "Example: Add provider-neutral run history with filters, persisted events, and recovery after restart."} disabled={planningActive}></textarea>
          <small>{plannerRequest.trim().length} characters · {plannerMode === "repository" ? "repository" : `workspace ${selectedWorkspaceSlug}`}</small>
        </label>

        <div class="planner-run-actions">
          {#if planningActive}
            <button class="secondary-button danger-button" type="button" onclick={cancelPlanning}>Cancel run</button>
          {:else}
            <button class="primary-button" type="button" onclick={startPlanning} disabled={!plannerRequest.trim() || !providerSelectionReady}>
              <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z"/></svg>
              Generate proposals
            </button>
          {/if}
          <span class="planning-status" data-status={planningStatus}><span></span>{planningStatus}</span>
        </div>
      </section>

      {#if planningLog || planningActive}
        <section class:collapsed={!streamExpanded} class="planning-stream" data-status={planningStatus} aria-label="Planning run console">
          <header class="run-console-header">
            <div class="run-console-identity">
              <span class="run-console-glyph" aria-hidden="true"><span></span><span></span><span></span></span>
              <div><p class="eyebrow">Run console</p><h3>{selectedRunner?.name ?? "Planning runner"}</h3><small>{streamSummary()}</small></div>
            </div>
            <div class="run-console-tools">
              <dl class="run-console-metrics">
                <div><dt>Elapsed</dt><dd>{formatPlanningDuration(planningElapsedMs)}</dd></div>
                <div><dt>Events</dt><dd>{planningEventCount.toLocaleString()}</dd></div>
                <div><dt>Data</dt><dd>{formatStreamSize(planningLog.length)}</dd></div>
              </dl>
              <button class="run-console-toggle" type="button" aria-expanded={streamExpanded} aria-label={streamExpanded ? "Collapse run transcript" : "Expand run transcript"} onclick={() => streamExpanded = !streamExpanded}>
                <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d={streamExpanded ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"}/></svg>
              </button>
            </div>
          </header>

          <div class="run-stage-rail" aria-label="Planning progress">
            <span data-state={planningStatus === "starting" ? "active" : "complete"}><i></i><strong>Session</strong><small>Runner connected</small></span>
            <span data-state={planningActive ? "active" : planningStatus === "completed" ? "complete" : planningStatus === "failed" || planningStatus === "cancelled" ? "error" : "waiting"}><i></i><strong>Inspect</strong><small>Repository context</small></span>
            <span data-state={planningStatus === "completed" ? "complete" : planningStatus === "failed" || planningStatus === "cancelled" ? "error" : "waiting"}><i></i><strong>Compose</strong><small>Structured proposals</small></span>
          </div>

          {#if streamExpanded}
            <div class="run-console-viewport" bind:this={planningViewport} onscroll={handleStreamScroll} aria-live={planningActive ? "polite" : "off"} aria-label="Provider transcript">
              {#if hiddenPlanningLineCount}
                <div class="run-console-truncation"><span>{hiddenPlanningLineCount.toLocaleString()} earlier lines retained</span><i></i></div>
              {/if}
              {#if visiblePlanningLines.length}
                <div class="run-console-lines">
                  {#each visiblePlanningLines as line}
                    <div class="run-console-line" data-kind={line.kind}>
                      <span>{line.number}</span><code>{line.text || " "}</code>
                    </div>
                  {/each}
                </div>
              {:else}
                <div class:delayed={planningSilenceMs >= 45_000} class="run-console-waiting">
                  <span class="run-waiting-signal" aria-hidden="true"><i></i><i></i><i></i></span>
                  <div><strong>{waitingTitle()}</strong><p>{waitingDetail()}</p></div>
                </div>
              {/if}
            </div>
            <footer class="run-console-footer">
              <span><i data-status={planningStatus}></i>{planningActive ? `Agent stream live · ${formatPlanningDuration(planningElapsedMs)}` : "Transcript complete"}</span>
              <span>Showing {visiblePlanningLines.length.toLocaleString()} of {allPlanningLines.length.toLocaleString()} lines</span>
              {#if !streamAutofollow && planningActive}<button type="button" onclick={resumeStreamTail}>Resume live tail</button>{/if}
            </footer>
          {:else}
            <button class="run-console-summary" type="button" onclick={() => streamExpanded = true}>
              <span class="run-summary-status" data-status={planningStatus} aria-hidden="true"><svg class="icon" viewBox="0 0 24 24"><path d={planningStatus === "completed" ? "m5 12 4 4L19 6" : "M12 7v5l3 2"}/><circle cx="12" cy="12" r="9"/></svg></span>
              <span><strong>{streamSummary()}</strong><small>Transcript retained · expand to inspect {allPlanningLines.length.toLocaleString()} lines</small></span>
              <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
            </button>
          {/if}
        </section>
      {/if}

      {#if plannerError}
        <div class="alert warning planner-alert" role="alert"><span aria-hidden="true">!</span><div><strong>Planning could not continue</strong><p>{plannerError}</p></div></div>
      {/if}

      {#if proposals}
        <section class="proposal-review">
          <header class="proposal-review-header">
            <div><p class="eyebrow">Human review gate</p><h3>Review {proposals.workspaces.length ? "workspace + " : ""}{proposals.tasks.length} {proposals.tasks.length === 1 ? "task" : "tasks"}</h3><p>Edit every contract before publishing canonical YAML.</p></div>
            <span>{selectedRunner?.name}</span>
          </header>

          {#each proposals.workspaces as workspaceProposal}
            <article class="workspace-proposal-card">
              <header>
                <span class="workspace-proposal-mark" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24"><rect x="3" y="4" width="7" height="7" rx="1"/><rect x="14" y="4" width="7" height="7" rx="1"/><rect x="3" y="15" width="7" height="6" rx="1"/><path d="M14 18h7M17.5 14.5v7"/></svg></span>
                <div><p class="eyebrow">Proposed workspace</p><strong>{workspaceProposal.name}</strong><small>{workspaceProposal.confidence} confidence</small></div>
              </header>
              <div class="proposal-form workspace-proposal-form">
                <label><span>Slug</span><input value={workspaceProposal.slug} type="text" oninput={(event) => updateWorkspaceSlug(event.currentTarget.value)} /></label>
                <label><span>Name</span><input bind:value={workspaceProposal.name} type="text" /></label>
                <label class="full-field"><span>Description</span><textarea bind:value={workspaceProposal.description} rows="2"></textarea></label>
                <label class="full-field"><span>Why this boundary</span><textarea bind:value={workspaceProposal.rationale} rows="2"></textarea></label>
              </div>
            </article>
          {/each}

          <div class="proposal-list">
            {#each proposals.tasks as proposal, proposalIndex}
              <article class="proposal-card">
                <header>
                  <span class="proposal-number">{String(proposalIndex + 1).padStart(2, "0")}</span>
                  <div><strong>{proposal.temporaryId}</strong><small>{proposal.confidence} confidence</small></div>
                  <button class="icon-button proposal-remove" type="button" aria-label={`Remove ${proposal.title}`} onclick={() => removeProposal(proposalIndex)}>
                    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V5h6v2M8 10v8M12 10v8M16 10v8M7 7l1 14h8l1-14"/></svg>
                  </button>
                </header>
                <div class="proposal-form">
                  <label class="full-field"><span>Title</span><input bind:value={proposal.title} type="text" /></label>
                  <label class="full-field"><span>Objective</span><textarea bind:value={proposal.objective} rows="3"></textarea></label>
                  <label><span>Kind</span><select bind:value={proposal.kind}>{#each TASK_KIND_OPTIONS as kind}<option value={kind}>{kind}</option>{/each}</select></label>
                  <label><span>Priority</span><select bind:value={proposal.priority}>{#each TASK_PRIORITY_OPTIONS as priority}<option value={priority}>{priority}</option>{/each}</select></label>
                  <label class="full-field"><span>Phase</span><input bind:value={proposal.phaseId} type="text" placeholder="planning" /></label>
                  <label class="full-field"><span>Suggested paths</span><textarea value={proposal.suggestedPaths.join("\n")} rows="3" oninput={(event) => updateSuggestedPaths(proposalIndex, event.currentTarget.value)}></textarea><small>One repository-relative path per line.</small></label>
                </div>
                <section class="proposal-criteria">
                  <div class="field-label">Acceptance criteria</div>
                  {#each proposal.acceptanceCriteria as criterion, criterionIndex}
                    <label><span>AC-{criterionIndex + 1}</span><textarea bind:value={criterion.statement} rows="2"></textarea></label>
                  {/each}
                </section>
                {#if proposal.risks.length || proposal.questions.length}
                  <footer class="proposal-notes">
                    {#if proposal.risks.length}<div><strong>Risks</strong>{#each proposal.risks as risk}<span>{risk}</span>{/each}</div>{/if}
                    {#if proposal.questions.length}<div><strong>Open questions</strong>{#each proposal.questions as question}<span>{question}</span>{/each}</div>{/if}
                  </footer>
                {/if}
              </article>
            {/each}
          </div>

          <footer class="publish-bar">
            <div>
              {#if published}<strong>Published successfully</strong><small>The workspace registry and canonical tasks have been refreshed.</small>{:else}<strong>Ready to publish</strong><small>Backend policy will validate every field again.</small>{/if}
            </div>
            <button class="primary-button" type="button" onclick={publishProposals} disabled={!proposals.tasks.length || publishing || published}>
              {publishing ? "Publishing…" : published ? "Published" : proposals.workspaces.length ? `Create workspace + ${proposals.tasks.length} ${proposals.tasks.length === 1 ? "task" : "tasks"}` : `Publish ${proposals.tasks.length} ${proposals.tasks.length === 1 ? "task" : "tasks"}`}
            </button>
          </footer>
        </section>
      {/if}
    </div>
  </div>
{/if}

{#if chatOpen && selectedCheckoutId && selectedRepository}
  {#key selectedCheckoutId}
    <RepositoryChatWorkspace
      checkoutId={selectedCheckoutId}
      repositoryName={selectedRepository.name}
      {runners}
      runnerId={plannerRunnerId}
      modelId={plannerModel}
      reasoningEffort={plannerReasoningEffort}
      active={!editorOpen}
      {terminalOpen}
      {terminalHeight}
      {terminalShortcutLabel}
      onSelectProvider={applyProviderSelection}
      onClose={() => chatOpen = false}
      onOpenExplorer={() => {
        openRepositoryEditor();
      }}
      onToggleTerminal={() => void toggleTerminal()}
      onCreateTaskProposal={(request) => {
        chatOpen = false;
        plannerRequest = request;
        openPlanner(selectedWorkspaceSlug ? "workspace" : "repository");
      }}
      onShowAgentConfiguration={() => {
        void revealAgentConfiguration();
      }}
    />
  {/key}
{/if}

{#if contentPanelTask}
  <TaskContentPanel
    bind:this={taskContentPanel}
    checkoutId={selectedCheckoutId}
    task={contentPanelTask}
    initializing={activeContentTaskKeys.has(canonicalTaskKey(contentPanelTask))}
    stream={contentLogs[canonicalTaskKey(contentPanelTask)] ?? ""}
    failure={contentFailures[canonicalTaskKey(contentPanelTask)] ?? ""}
    canInitialize={Boolean(plannerRunnerId)}
    canRun={providerSelectionReady}
    runCount={agentRuns.filter((run) => run.taskKey === canonicalTaskKey(contentPanelTask)).length}
    onClose={() => contentPanelTaskKey = ""}
    onEdit={editTaskContent}
    onInitialize={(task) => initializeTaskContent([canonicalTaskKey(task)])}
    onRun={(task) => openExecutionWorkbench(task)}
  />
{/if}

{#if editorOpen && selectedCheckoutId}
  <RepositoryWorkbench
    bind:this={repositoryWorkbench}
    checkoutId={selectedCheckoutId}
    initialPath={editorInitialPath}
    theme={theme === "dark" ? "dark" : "light"}
    panelOpen={terminalOpen && Boolean(selectedRepository)}
    panelHeight={terminalHeight}
    panelMaximized={terminalMaximized}
    terminalShortcutLabel={terminalShortcutLabel}
    onClose={() => editorOpen = false}
    onSaved={handleEditorSaved}
    onToggleTerminal={() => void toggleTerminal()}
  ></RepositoryWorkbench>
{/if}

{#if terminalOpen && selectedCheckoutId && selectedRepository}
  {#key selectedCheckoutId}
    <TerminalPanel
      bind:this={terminalPanel}
      checkoutId={selectedCheckoutId}
      repositoryName={selectedRepository.name}
      theme={theme === "dark" ? "dark" : "light"}
      height={terminalHeight}
      maximized={terminalMaximized}
      repositoryWorkbench={editorOpen}
      shortcutLabel={terminalShortcutLabel}
      onClose={() => void closeTerminal(editorOpen)}
      onHeightChange={updateTerminalHeight}
      onToggleMaximized={() => terminalMaximized = !terminalMaximized}
    />
  {/key}
{/if}
