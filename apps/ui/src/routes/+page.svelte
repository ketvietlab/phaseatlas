<script lang="ts">
  import { onMount, tick } from "svelte";
  import RepositoryWorkbench from "$lib/RepositoryWorkbench.svelte";
  import TerminalPanel from "$lib/TerminalPanel.svelte";
  import TaskContentPanel from "$lib/TaskContentPanel.svelte";
  import TaskMap from "$lib/TaskMap.svelte";
  import type {
    CanonicalTask,
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
  const TERMINAL_HEIGHT_STORAGE_KEY = "phaseatlas.terminal-height.v1";

  type RepositoryProviderSettings = Record<string, { runnerId: string; modelId: string }>;

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
  let opening = false;
  let refreshing = false;
  let menuOpen = false;
  let errorMessage = "";
  let refreshTimer = 0;
  let plannerOpen = false;
  let providerSettingsOpen = false;
  let plannerRequest = "";
  let plannerRunnerId = "";
  let plannerModel = "";
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
  let terminalOpen = false;
  let terminalMaximized = false;
  let terminalHeight = 300;
  let terminalPanel: { focus(): void } | undefined;

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
  $: providerSelectionReady = Boolean(
    selectedRunner?.available && selectedModels.some((model) => model.id === plannerModel),
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
  $: terminalShortcutLabel = platform === "darwin" ? "⌘`" : "Ctrl+`";
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
      if (event.type === "repository.changed") {
        window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(() => void refreshRepository(event.checkoutId), 180);
      }
    });

    void initialize();
    return () => {
      window.clearTimeout(refreshTimer);
      window.clearInterval(planningClockTimer);
      unsubscribe();
    };
  });

  async function initialize() {
    if (!window.phaseatlas) return;
    try {
      [repositories, platform] = await Promise.all([
        window.phaseatlas.repositories.list(),
        window.phaseatlas.runtime.platform(),
      ]);
      if (repositories[0]) await selectRepository(repositories[0].checkoutId);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "PhaseAtlas could not be initialized.";
    } finally {
      loading = false;
    }
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
    selectedCheckoutId = checkoutId;
    workspaces = [];
    runners = [];
    taskSnapshot = null;
    selectedWorkspaceSlug = "";
    selectedTaskKey = "";
    editorOpen = false;
    contentPanelTaskKey = "";
    contentRuns = {};
    contentTaskStatuses = {};
    contentTaskRunIds = {};
    contentLogs = {};
    contentFailures = {};
    openEditorAfterTask = {};
    errorMessage = "";
    menuOpen = false;
    try {
      const recoveredRepository = await window.phaseatlas.repositories.refresh(checkoutId);
      const [nextWorkspaces, nextTaskSnapshot, nextRunners, activeContentRuns] = await Promise.all([
        window.phaseatlas.workspaces.list(checkoutId),
        window.phaseatlas.tasks.snapshot(checkoutId),
        window.phaseatlas.runners.list(checkoutId),
        window.phaseatlas.tasks.listContentRuns(checkoutId),
      ]);
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
      applyRepositoryProviderSettings(checkoutId);
      selectWorkspace(workspaces[0]?.slug ?? "");
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "The repository workspaces could not be read.";
    }
  }

  async function toggleTerminal() {
    if (!selectedCheckoutId) return;
    terminalOpen = !terminalOpen;
    if (!terminalOpen) {
      terminalMaximized = false;
      return;
    }
    await tick();
    terminalPanel?.focus();
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

  function applyRepositoryProviderSettings(checkoutId: string) {
    const saved = readRepositoryProviderSettings()[checkoutId];
    const runner = runners.find((candidate) => candidate.available && candidate.id === saved?.runnerId)
      ?? runners.find((candidate) => candidate.available && candidate.models?.length > 0)
      ?? runners.find((candidate) => candidate.available);
    plannerRunnerId = runner?.id ?? "";
    plannerModel = runner?.models?.some((model) => model.id === saved?.modelId)
      ? saved.modelId
      : defaultModelId(runner);
    if (plannerRunnerId && plannerModel) persistRepositoryProviderSettings();
  }

  function persistRepositoryProviderSettings() {
    if (!selectedCheckoutId || !plannerRunnerId || !plannerModel) return;
    const settings = readRepositoryProviderSettings();
    settings[selectedCheckoutId] = { runnerId: plannerRunnerId, modelId: plannerModel };
    window.localStorage.setItem(PROVIDER_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }

  function selectProviderRunner(runnerId: string) {
    plannerRunnerId = runnerId;
    plannerModel = defaultModelId(runners.find((runner) => runner.id === runnerId));
    persistRepositoryProviderSettings();
  }

  function selectProviderModel(modelId: string) {
    if (!selectedModels.some((model) => model.id === modelId)) return;
    plannerModel = modelId;
    persistRepositoryProviderSettings();
  }

  async function refreshRepository(checkoutId: string) {
    if (!window.phaseatlas || refreshing || checkoutId !== selectedCheckoutId) return;
    refreshing = true;
    errorMessage = "";
    try {
      const repository = await window.phaseatlas.repositories.refresh(checkoutId);
      const [nextWorkspaces, nextTaskSnapshot] = await Promise.all([
        window.phaseatlas.workspaces.list(checkoutId),
        window.phaseatlas.tasks.snapshot(checkoutId),
      ]);
      repositories = repositories.map((item) => item.checkoutId === checkoutId ? repository : item);
      workspaces = nextWorkspaces;
      taskSnapshot = nextTaskSnapshot;
      const workspaceSlug = nextWorkspaces.some((item) => item.slug === selectedWorkspaceSlug)
        ? selectedWorkspaceSlug
        : nextWorkspaces[0]?.slug ?? "";
      selectWorkspace(workspaceSlug, selectedTaskKey);
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
      errorMessage = "Choose a provider model from Repository settings before initializing task content.";
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
    if (selectedCheckoutId === checkoutId) {
      selectedCheckoutId = "";
      workspaces = [];
      runners = [];
      taskSnapshot = null;
      selectedWorkspaceSlug = "";
      selectedTaskKey = "";
      terminalMaximized = false;
      if (repositories[0]) await selectRepository(repositories[0].checkoutId);
      else terminalOpen = false;
    }
  }

  function setTheme(nextTheme: "light" | "dark") {
    theme = nextTheme;
    document.documentElement.dataset.theme = nextTheme;
    localStorage.setItem("phaseatlas-theme", nextTheme);
  }

  function handleWindowKeydown(event: KeyboardEvent) {
    const modifier = event.metaKey || event.ctrlKey;
    const terminalShortcut = modifier && !event.shiftKey && !event.altKey && (
      event.code === "Backquote" || event.key.toLowerCase() === "j"
    );
    if (terminalShortcut && !event.repeat && !plannerOpen && !providerSettingsOpen && !editorOpen && !contentPanelTask) {
      event.preventDefault();
      void toggleTerminal();
      return;
    }
    if (event.key !== "Escape") return;
    if (terminalMaximized) terminalMaximized = false;
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
      <img class="product-mark" src="./assets/phaseatlas-logo-mark.png" width="1254" height="1254" alt="" />
      <span class="product-name"><strong>PhaseAtlas</strong><small>KétViệt workspace</small></span>
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
            <span class="repository-mark" aria-hidden="true">{repository.name.slice(0, 2).toUpperCase()}</span>
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
      <img class="product-mark" src="./assets/phaseatlas-logo-mark.png" width="1254" height="1254" alt="" />
      <span class="product-name"><strong>PhaseAtlas</strong><small>KétViệt workspace</small></span>
    </div>
    <button class="icon-button" type="button" aria-label={menuOpen ? "Close menu" : "Open menu"} aria-expanded={menuOpen} onclick={() => (menuOpen = !menuOpen)}>
      <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">{#if menuOpen}<path d="m6 6 12 12M18 6 6 18"/>{:else}<path d="M4 7h16M4 12h16M4 17h16"/>{/if}</svg>
    </button>
  </header>
  {#if menuOpen}<button class="sidebar-backdrop" type="button" aria-label="Close menu" onclick={() => (menuOpen = false)}></button>{/if}

  <main
    class:terminal-visible={terminalOpen && Boolean(selectedCheckoutId) && !terminalMaximized}
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
            <button class="secondary-button" type="button" onclick={() => openRepositoryEditor()}>
              <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4zM8 5v14M11 9h6M11 13h4"/></svg>
              Explorer
            </button>
            <button class="secondary-button" type="button" onclick={() => providerSettingsOpen = true}>
              <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21h-4v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3.1 14H3v-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3.1V3h4v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.1v4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>
              Provider settings
            </button>
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
          {#if workspaces.length}
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
                      <div class="task-badges"><span class="state-badge" data-state={selectedTask.state}>{stateLabel(selectedTask.state)}</span><span class="priority-badge" data-priority={selectedTask.priority}>{selectedTask.priority}</span></div>
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
          {:else}
            <div class="card empty-state">
              <img src="./assets/phaseatlas-logo-mark.png" width="1254" height="1254" alt="" aria-hidden="true" />
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

{#if providerSettingsOpen}
  <button class="provider-settings-backdrop" type="button" aria-label="Close repository provider settings" onclick={() => providerSettingsOpen = false}></button>
  <div class="provider-settings-panel" role="dialog" aria-modal="true" aria-labelledby="provider-settings-title">
    <header>
      <div>
        <p class="eyebrow">Repository preferences</p>
        <h2 id="provider-settings-title">Provider settings</h2>
        <p>{selectedRepository?.name} · applies to planning and task content</p>
      </div>
      <button class="icon-button" type="button" aria-label="Close repository provider settings" onclick={() => providerSettingsOpen = false}>
        <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>
      </button>
    </header>
    <div class="provider-settings-body">
      <section class="provider-settings-intro">
        <span class="provider-settings-icon" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24"><path d="M5 5h14v14H5zM9 9h6M9 13h4"/></svg></span>
        <div><strong>Choose the agent CLI for this repository</strong><p>PhaseAtlas keeps this preference outside source control. Credentials remain managed by the selected CLI.</p></div>
      </section>

      <label class="provider-settings-field">
        <span>Provider CLI</span>
        <select value={plannerRunnerId} onchange={(event) => selectProviderRunner(event.currentTarget.value)}>
          {#each runners as runner}
            <option value={runner.id} disabled={!runner.available}>{runner.name}{runner.available ? ` · ${runner.version ?? runner.provider}` : " · unavailable"}</option>
          {/each}
        </select>
      </label>

      <label class="provider-settings-field">
        <span>Model</span>
        <select value={plannerModel} onchange={(event) => selectProviderModel(event.currentTarget.value)} disabled={!selectedModels.length}>
          {#if selectedModels.length}
            {#each selectedModels as model}
              <option value={model.id}>{model.displayName}{model.isDefault ? " · provider default" : ""}</option>
            {/each}
          {:else}
            <option value="">No provider models available</option>
          {/if}
        </select>
        <small>{selectedRunner?.modelDiscovery?.status === "available" ? `${selectedModels.length} models discovered from ${selectedRunner.name}.` : selectedRunner?.modelDiscovery?.unavailableReason ?? "Restart PhaseAtlas to load the provider model catalog."}</small>
      </label>

      {#if selectedRunner}
        <section class:unavailable={!providerSelectionReady} class="provider-settings-status">
          <span></span>
          <div>
            <strong>{providerSelectionReady ? "Ready for this repository" : "Provider setup required"}</strong>
            <p>{providerSelectionReady ? `${selectedRunner.name} will use ${selectedModels.find((model) => model.id === plannerModel)?.displayName}.` : selectedRunner.modelDiscovery?.unavailableReason ?? selectedRunner.unavailableReason ?? "Restart PhaseAtlas to refresh provider discovery."}</p>
          </div>
        </section>
      {/if}
    </div>
    <footer>
      <span>Saved automatically on this device</span>
      <button class="primary-button" type="button" onclick={() => providerSettingsOpen = false} disabled={!providerSelectionReady}>Done</button>
    </footer>
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
        <div class="planner-step-heading"><span>01</span><div><strong>Choose a runner</strong><small>Provider credentials stay inside the repository worker.</small></div></div>
        <div class="runner-fields">
          <label>
            <span>Runner</span>
            <select value={plannerRunnerId} onchange={(event) => selectProviderRunner(event.currentTarget.value)} disabled={planningActive}>
              {#each runners as runner}
                <option value={runner.id} disabled={!runner.available}>{runner.name}{runner.available ? ` · ${runner.version ?? runner.provider}` : " · unavailable"}</option>
              {/each}
            </select>
          </label>
          <label>
            <span>Model</span>
            <select value={plannerModel} onchange={(event) => selectProviderModel(event.currentTarget.value)} disabled={planningActive || !selectedModels.length}>
              {#if selectedModels.length}
                {#each selectedModels as model}
                  <option value={model.id}>{model.displayName}{model.isDefault ? " · default" : ""}</option>
                {/each}
              {:else}
                <option value="">Model catalog unavailable</option>
              {/if}
            </select>
          </label>
        </div>
        {#if selectedRunner}
          <div class:unavailable={!selectedRunner.available} class="runner-summary">
            <span class="runner-status-dot"></span>
            <div><strong>{selectedRunner.name}</strong><small>{selectedRunner.available ? selectedRunner.capabilities.join(" · ") : selectedRunner.unavailableReason}</small></div>
          </div>
        {:else}
          <div class="runner-summary unavailable"><span class="runner-status-dot"></span><div><strong>No runner available</strong><small>Install or authenticate a supported CLI in the desktop environment.</small></div></div>
        {/if}

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

{#if contentPanelTask}
  <TaskContentPanel
    task={contentPanelTask}
    initializing={activeContentTaskKeys.has(canonicalTaskKey(contentPanelTask))}
    stream={contentLogs[canonicalTaskKey(contentPanelTask)] ?? ""}
    failure={contentFailures[canonicalTaskKey(contentPanelTask)] ?? ""}
    canInitialize={Boolean(plannerRunnerId)}
    onClose={() => contentPanelTaskKey = ""}
    onEdit={editTaskContent}
    onInitialize={(task) => initializeTaskContent([canonicalTaskKey(task)])}
  />
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
      shortcutLabel={terminalShortcutLabel}
      onClose={() => {
        terminalOpen = false;
        terminalMaximized = false;
      }}
      onHeightChange={updateTerminalHeight}
      onToggleMaximized={() => terminalMaximized = !terminalMaximized}
    />
  {/key}
{/if}

{#if editorOpen && selectedCheckoutId}
  <RepositoryWorkbench
    checkoutId={selectedCheckoutId}
    initialPath={editorInitialPath}
    theme={theme === "dark" ? "dark" : "light"}
    onClose={() => editorOpen = false}
    onSaved={handleEditorSaved}
  />
{/if}
