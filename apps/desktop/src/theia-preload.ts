import { contextBridge, ipcRenderer } from "electron";
import type {
  IdeAgentConfiguration,
  IdeAgentSelection,
  TaskRegistryPublishResult,
  TaskRegistrySource,
  TaskRegistryValidation,
} from "@phaseatlas/contracts";
import {
  applyPhaseAtlasTheiaStyle,
  setPhaseAtlasTheiaTheme,
  type PhaseAtlasIdeTheme,
} from "./theia-phaseatlas-style.js";

// The IDE view is a sandboxed web surface like the renderer: it receives the
// current theme and a worker-validated provider projection, and may return only
// one of those selections. No desktop capabilities are exposed. Theia still
// owns editors, commands, files, terminals and extensions.
const initialTheme: PhaseAtlasIdeTheme = ipcRenderer.sendSync("phaseatlas:ide:theme:get") === "dark" ? "dark" : "light";
let currentTheme: PhaseAtlasIdeTheme = initialTheme;
const themeCallbacks = new Set<(theme: PhaseAtlasIdeTheme) => void>();
const initialAgentConfiguration = ipcRenderer.sendSync("phaseatlas:ide:agent:configuration:get") as unknown;
let agentConfiguration: IdeAgentConfiguration | undefined = isAgentConfiguration(initialAgentConfiguration)
  ? initialAgentConfiguration
  : undefined;
const agentConfigurationCallbacks = new Set<(configuration: IdeAgentConfiguration) => void>();
let agentUiTimer = 0;
let preferIncomingAgentConfiguration = Boolean(agentConfiguration);
let taskRegistrySource: TaskRegistrySource | undefined;
let taskRegistryTimer = 0;

function isAgentConfiguration(value: unknown): value is IdeAgentConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<IdeAgentConfiguration>;
  return typeof candidate.runnerId === "string" &&
    typeof candidate.modelId === "string" &&
    Array.isArray(candidate.agents);
}

function defaultModel(configuration: IdeAgentConfiguration, runnerId: string) {
  const agent = configuration.agents.find((candidate) => candidate.runnerId === runnerId);
  return agent?.models.find((model) => model.isDefault) ?? agent?.models[0];
}

function selectionForRunner(configuration: IdeAgentConfiguration, runnerId: string): IdeAgentSelection | undefined {
  const model = defaultModel(configuration, runnerId);
  if (!model) return undefined;
  const effort = model.defaultReasoningEffort && model.reasoningEfforts.includes(model.defaultReasoningEffort)
    ? model.defaultReasoningEffort
    : undefined;
  return {
    runnerId,
    modelId: model.id,
    ...(effort ? { reasoningEffort: effort } : {}),
  };
}

function publishAgentSelection(selection: IdeAgentSelection): void {
  ipcRenderer.send("phaseatlas:ide:agent:selection", selection);
}

function selectElement(label: string, className: string): { field: HTMLLabelElement; select: HTMLSelectElement } {
  const field = document.createElement("label");
  field.className = "phaseatlas-agent-field";
  const caption = document.createElement("span");
  caption.textContent = label;
  const select = document.createElement("select");
  select.className = className;
  field.append(caption, select);
  return { field, select };
}

function replaceOptions(select: HTMLSelectElement, options: Array<{ value: string; label: string }>, value: string): void {
  const signature = JSON.stringify(options);
  if (select.dataset.options !== signature) {
    select.replaceChildren(...options.map((option) => {
      const element = document.createElement("option");
      element.value = option.value;
      element.textContent = option.label;
      return element;
    }));
    select.dataset.options = signature;
  }
  select.value = value;
}

function updateAgentBar(bar: HTMLElement, configuration: IdeAgentConfiguration): void {
  const agentSelect = bar.querySelector<HTMLSelectElement>(".phaseatlas-agent-select");
  const modelSelect = bar.querySelector<HTMLSelectElement>(".phaseatlas-model-select");
  const effortSelect = bar.querySelector<HTMLSelectElement>(".phaseatlas-effort-select");
  const effortField = effortSelect?.closest<HTMLElement>(".phaseatlas-agent-field");
  if (!agentSelect || !modelSelect || !effortSelect || !effortField) return;
  const agent = configuration.agents.find((candidate) => candidate.runnerId === configuration.runnerId)
    ?? configuration.agents[0];
  const model = agent?.models.find((candidate) => candidate.id === configuration.modelId)
    ?? defaultModel(configuration, agent?.runnerId ?? "");
  if (!agent || !model) return;
  replaceOptions(agentSelect, configuration.agents.map((candidate) => ({
    value: candidate.runnerId,
    label: candidate.label,
  })), agent.runnerId);
  replaceOptions(modelSelect, agent.models.map((candidate) => ({ value: candidate.id, label: candidate.label })), model.id);
  replaceOptions(effortSelect, [
    ...(!model.defaultReasoningEffort ? [{ value: "", label: "Default" }] : []),
    ...model.reasoningEfforts.map((effort) => ({ value: effort, label: effort })),
  ], configuration.reasoningEffort ?? model.defaultReasoningEffort ?? "");
  effortField.hidden = model.reasoningEfforts.length === 0;
  bar.dataset.runnerId = agent.runnerId;
  bar.dataset.modelId = model.id;
  bar.dataset.reasoningEffort = configuration.reasoningEffort ?? "";
}

function createAgentBar(configuration: IdeAgentConfiguration): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "phaseatlas-agent-bar";
  const identity = document.createElement("span");
  identity.className = "phaseatlas-agent-identity";
  identity.textContent = "PhaseAtlas";
  identity.title = "Repository agent settings are synchronized with PhaseAtlas";
  const agent = selectElement("Agent", "phaseatlas-agent-select");
  const model = selectElement("Model", "phaseatlas-model-select");
  const effort = selectElement("Effort", "phaseatlas-effort-select");
  bar.append(identity, agent.field, model.field, effort.field);

  agent.select.addEventListener("change", () => {
    if (!agentConfiguration) return;
    const selection = selectionForRunner(agentConfiguration, agent.select.value);
    if (selection) publishAgentSelection(selection);
  });
  model.select.addEventListener("change", () => {
    if (!agentConfiguration) return;
    const selectedAgent = agentConfiguration.agents.find((candidate) => candidate.runnerId === agent.select.value);
    const selectedModel = selectedAgent?.models.find((candidate) => candidate.id === model.select.value);
    if (!selectedAgent || !selectedModel) return;
    const defaultEffort = selectedModel.defaultReasoningEffort && selectedModel.reasoningEfforts.includes(selectedModel.defaultReasoningEffort)
      ? selectedModel.defaultReasoningEffort
      : undefined;
    publishAgentSelection({
      runnerId: selectedAgent.runnerId,
      modelId: selectedModel.id,
      ...(defaultEffort ? { reasoningEffort: defaultEffort } : {}),
    });
  });
  effort.select.addEventListener("change", () => {
    publishAgentSelection({
      runnerId: agent.select.value,
      modelId: model.select.value,
      ...(effort.select.value ? { reasoningEffort: effort.select.value } : {}),
    });
  });
  updateAgentBar(bar, configuration);
  return bar;
}

function pinnedAgent(configuration: IdeAgentConfiguration): { button: HTMLElement; runnerId: string } | undefined {
  const button = [...document.querySelectorAll<HTMLElement>(".theia-ChatInputOptions-left .option")]
    .find((option) => option.title === "Unpin Agent");
  const label = button?.textContent?.trim().toLowerCase();
  if (!label) return undefined;
  const runnerId = configuration.agents.find((agent) => {
    const normalized = agent.theiaAgentId.toLowerCase();
    return label.includes(normalized) || label.includes(agent.label.toLowerCase());
  })?.runnerId;
  return button && runnerId ? { button, runnerId } : undefined;
}

function reconcileAgentUi(): void {
  if (!agentConfiguration) return;
  for (const input of document.querySelectorAll<HTMLElement>("#chat-view-widget .theia-ChatInput")) {
    let bar = input.querySelector<HTMLElement>(":scope > .phaseatlas-agent-bar");
    if (!bar) {
      bar = createAgentBar(agentConfiguration);
      input.prepend(bar);
    } else {
      updateAgentBar(bar, agentConfiguration);
    }
  }
  const pinned = pinnedAgent(agentConfiguration);
  if (pinned && pinned.runnerId !== agentConfiguration.runnerId) {
    if (preferIncomingAgentConfiguration) {
      // A repository-level change should release an older session pin so the
      // new Theia default can take effect. A pin changed directly in Theia has
      // no incoming event yet and follows the reverse-sync branch below.
      pinned.button.click();
    } else {
      const selection = selectionForRunner(agentConfiguration, pinned.runnerId);
      if (selection) publishAgentSelection(selection);
    }
  }
  preferIncomingAgentConfiguration = false;
}

function scheduleAgentUi(): void {
  window.clearTimeout(agentUiTimer);
  agentUiTimer = window.setTimeout(reconcileAgentUi, 50);
}

function compactCommit(commit: string): string {
  return commit.slice(0, 8);
}

function updateTaskRegistryBar(bar: HTMLElement, source: TaskRegistrySource, message = ""): void {
  taskRegistrySource = source;
  const state = bar.querySelector<HTMLElement>(".phaseatlas-task-registry-state");
  const detail = bar.querySelector<HTMLElement>(".phaseatlas-task-registry-detail");
  const publish = bar.querySelector<HTMLButtonElement>(".phaseatlas-task-registry-publish");
  const discard = bar.querySelector<HTMLButtonElement>(".phaseatlas-task-registry-discard");
  if (!state || !detail || !publish || !discard) return;
  const draft = source.changedPaths.length > 0;
  state.dataset.state = draft ? "draft" : "current";
  state.textContent = draft ? `${source.changedPaths.length} draft ${source.changedPaths.length === 1 ? "file" : "files"}` : "Current";
  detail.textContent = message || `${source.ref.replace("refs/heads/", "")} · ${compactCommit(source.commit)}`;
  publish.disabled = !draft;
  discard.disabled = !draft;
}

async function refreshTaskRegistryBar(bar: HTMLElement): Promise<void> {
  try {
    const source = await ipcRenderer.invoke("phaseatlas:ide:tasks:context") as TaskRegistrySource | null;
    if (!source) {
      bar.remove();
      return;
    }
    updateTaskRegistryBar(bar, source);
  } catch (error) {
    const detail = bar.querySelector<HTMLElement>(".phaseatlas-task-registry-detail");
    if (detail) detail.textContent = error instanceof Error ? error.message : "Task registry unavailable";
  }
}

function createTaskRegistryBar(): HTMLElement {
  const bar = document.createElement("aside");
  bar.className = "phaseatlas-task-registry-bar";
  bar.setAttribute("aria-label", "PhaseAtlas task registry controls");
  bar.innerHTML = `
    <span class="phaseatlas-task-registry-mark" aria-hidden="true">PA</span>
    <span class="phaseatlas-task-registry-copy">
      <strong>Task Registry</strong>
      <small class="phaseatlas-task-registry-detail">Loading canonical source…</small>
    </span>
    <span class="phaseatlas-task-registry-state" data-state="current">Loading</span>
    <button class="phaseatlas-task-registry-validate" type="button">Validate</button>
    <button class="phaseatlas-task-registry-discard" type="button" disabled>Discard</button>
    <button class="phaseatlas-task-registry-publish" type="button" disabled>Review &amp; Publish</button>
  `;
  bar.querySelector<HTMLButtonElement>(".phaseatlas-task-registry-validate")?.addEventListener("click", async () => {
    const button = bar.querySelector<HTMLButtonElement>(".phaseatlas-task-registry-validate");
    if (!button) return;
    button.disabled = true;
    try {
      const result = await ipcRenderer.invoke("phaseatlas:ide:tasks:validate") as TaskRegistryValidation;
      const errors = result.issues.filter((issue) => issue.severity === "error");
      updateTaskRegistryBar(bar, result.source, errors.length
        ? `${errors.length} validation ${errors.length === 1 ? "error" : "errors"}`
        : "Validated · ready to publish");
    } catch (error) {
      if (taskRegistrySource) updateTaskRegistryBar(bar, taskRegistrySource, error instanceof Error ? error.message : "Validation failed");
    } finally {
      button.disabled = false;
    }
  });
  bar.querySelector<HTMLButtonElement>(".phaseatlas-task-registry-publish")?.addEventListener("click", async () => {
    if (!taskRegistrySource?.changedPaths.length) return;
    const files = taskRegistrySource.changedPaths.map((candidate) => `• ${candidate}`).join("\n");
    if (!window.confirm(`Publish these task registry changes?\n\n${files}`)) return;
    const message = window.prompt("Commit message for the canonical task registry", "tasks: update canonical task registry")?.trim();
    if (!message) return;
    const button = bar.querySelector<HTMLButtonElement>(".phaseatlas-task-registry-publish");
    if (!button) return;
    button.disabled = true;
    try {
      const result = await ipcRenderer.invoke("phaseatlas:ide:tasks:publish", {
        expectedCommit: taskRegistrySource.commit,
        message,
      }) as TaskRegistryPublishResult;
      updateTaskRegistryBar(bar, result.source, "Published canonical task changes");
    } catch (error) {
      updateTaskRegistryBar(bar, taskRegistrySource, error instanceof Error ? error.message : "Publish failed");
    }
  });
  bar.querySelector<HTMLButtonElement>(".phaseatlas-task-registry-discard")?.addEventListener("click", async () => {
    if (!taskRegistrySource?.changedPaths.length || !window.confirm("Discard every unpublished task registry change?")) return;
    const source = await ipcRenderer.invoke("phaseatlas:ide:tasks:discard", taskRegistrySource.commit) as TaskRegistrySource;
    updateTaskRegistryBar(bar, source, "Draft discarded");
    window.location.reload();
  });
  return bar;
}

async function mountTaskRegistryBar(): Promise<void> {
  const source = await ipcRenderer.invoke("phaseatlas:ide:tasks:context") as TaskRegistrySource | null;
  if (!source || document.querySelector(".phaseatlas-task-registry-bar")) return;
  const bar = createTaskRegistryBar();
  document.body.append(bar);
  updateTaskRegistryBar(bar, source);
  window.clearInterval(taskRegistryTimer);
  taskRegistryTimer = window.setInterval(() => void refreshTaskRegistryBar(bar), 1_500);
}

setPhaseAtlasTheiaTheme(initialTheme);
applyPhaseAtlasTheiaStyle(initialTheme);

window.addEventListener("DOMContentLoaded", () => {
  const observer = new MutationObserver(scheduleAgentUi);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  scheduleAgentUi();
  void mountTaskRegistryBar();
});

ipcRenderer.on("phaseatlas:ide:theme-changed", (_event, theme: unknown) => {
  if (theme !== "light" && theme !== "dark") return;
  if (theme === currentTheme) return;
  currentTheme = theme;
  setPhaseAtlasTheiaTheme(theme);
  applyPhaseAtlasTheiaStyle(theme);
  for (const callback of themeCallbacks) callback(theme);
  // Theia reads its Monaco color theme at frontend startup. Reconnecting this
  // view keeps the backend and workspace alive while applying the matching
  // syntax theme as well as the PhaseAtlas chrome tokens.
  window.location.reload();
});

ipcRenderer.on("phaseatlas:ide:agent:configuration", (_event, configuration: unknown) => {
  if (!isAgentConfiguration(configuration)) return;
  agentConfiguration = configuration;
  preferIncomingAgentConfiguration = true;
  for (const callback of agentConfigurationCallbacks) callback(configuration);
  scheduleAgentUi();
});

const api = Object.freeze({
  getTheme: () => currentTheme,
  onThemeChanged: (callback: (theme: PhaseAtlasIdeTheme) => void) => {
    themeCallbacks.add(callback);
  },
  getAgentConfiguration: () => agentConfiguration,
  onAgentConfigurationChanged: (callback: (configuration: IdeAgentConfiguration) => void) => {
    agentConfigurationCallbacks.add(callback);
  },
});

contextBridge.exposeInMainWorld("phaseatlasIde", api);
