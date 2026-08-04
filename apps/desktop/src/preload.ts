import { contextBridge, ipcRenderer } from "electron";
import type { PhaseAtlasDesktopApi, PhaseAtlasDesktopEvent } from "@phaseatlas/contracts";

const api: PhaseAtlasDesktopApi = {
  repositories: {
    open: () => ipcRenderer.invoke("phaseatlas:repositories:open"),
    close: (checkoutId) => ipcRenderer.invoke("phaseatlas:repositories:close", checkoutId),
    list: () => ipcRenderer.invoke("phaseatlas:repositories:list"),
    refresh: (checkoutId) => ipcRenderer.invoke("phaseatlas:repositories:refresh", checkoutId),
  },
  workspaces: {
    list: (checkoutId) => ipcRenderer.invoke("phaseatlas:workspaces:list", checkoutId),
  },
  tasks: {
    snapshot: (checkoutId) => ipcRenderer.invoke("phaseatlas:tasks:snapshot", checkoutId),
    listContentRuns: (checkoutId) => ipcRenderer.invoke("phaseatlas:tasks:content:list", checkoutId),
    initializeContent: (checkoutId, input) => ipcRenderer.invoke("phaseatlas:tasks:content:start", checkoutId, input),
    cancelContent: (checkoutId, runId) => ipcRenderer.invoke("phaseatlas:tasks:content:cancel", checkoutId, runId),
    saveContent: (checkoutId, taskKey, body) => ipcRenderer.invoke(
      "phaseatlas:tasks:content:save",
      checkoutId,
      taskKey,
      body,
    ),
  },
  files: {
    list: (checkoutId, directory = "") => ipcRenderer.invoke("phaseatlas:files:list", checkoutId, directory),
    read: (checkoutId, path) => ipcRenderer.invoke("phaseatlas:files:read", checkoutId, path),
    save: (checkoutId, path, content) => ipcRenderer.invoke("phaseatlas:files:save", checkoutId, path, content),
  },
  runners: {
    list: (checkoutId) => ipcRenderer.invoke("phaseatlas:runners:list", checkoutId),
  },
  planning: {
    start: (checkoutId, input) => ipcRenderer.invoke("phaseatlas:planning:start", checkoutId, input),
    cancel: (checkoutId, runId) => ipcRenderer.invoke("phaseatlas:planning:cancel", checkoutId, runId),
    publish: (checkoutId, input) => ipcRenderer.invoke(
      "phaseatlas:planning:publish",
      checkoutId,
      input,
    ),
  },
  agentRuns: {
    actions: (checkoutId, input) => ipcRenderer.invoke("phaseatlas:agent-runs:actions", checkoutId, input),
    list: (checkoutId, taskKey) => ipcRenderer.invoke("phaseatlas:agent-runs:list", checkoutId, taskKey),
    start: (checkoutId, input) => ipcRenderer.invoke("phaseatlas:agent-runs:start", checkoutId, input),
    cancel: (checkoutId, runId) => ipcRenderer.invoke("phaseatlas:agent-runs:cancel", checkoutId, runId),
    events: (checkoutId, runId, afterSequence = 0, limit = 200) => ipcRenderer.invoke(
      "phaseatlas:agent-runs:events",
      checkoutId,
      runId,
      afterSequence,
      limit,
    ),
    commandOutput: (checkoutId, runId, commandId, offset = 0, limit = 20_000) => ipcRenderer.invoke(
      "phaseatlas:agent-runs:command-output",
      checkoutId,
      runId,
      commandId,
      offset,
      limit,
    ),
    result: (checkoutId, runId) => ipcRenderer.invoke("phaseatlas:agent-runs:result", checkoutId, runId),
    recover: (checkoutId, input) => ipcRenderer.invoke("phaseatlas:agent-runs:recover", checkoutId, input),
  },
  terminals: {
    list: (checkoutId) => ipcRenderer.invoke("phaseatlas:terminals:list", checkoutId),
    create: (checkoutId, input) => ipcRenderer.invoke("phaseatlas:terminals:create", checkoutId, input),
    write: (checkoutId, sessionId, data) => ipcRenderer.invoke(
      "phaseatlas:terminals:write",
      checkoutId,
      sessionId,
      data,
    ),
    resize: (checkoutId, sessionId, cols, rows) => ipcRenderer.invoke(
      "phaseatlas:terminals:resize",
      checkoutId,
      sessionId,
      cols,
      rows,
    ),
    close: (checkoutId, sessionId) => ipcRenderer.invoke("phaseatlas:terminals:close", checkoutId, sessionId),
  },
  chat: {
    createSession: (checkoutId, input) => ipcRenderer.invoke("phaseatlas:chat:sessions:create", checkoutId, input),
    listSessions: (checkoutId) => ipcRenderer.invoke("phaseatlas:chat:sessions:list", checkoutId),
    getSession: (checkoutId, sessionId) => ipcRenderer.invoke("phaseatlas:chat:sessions:get", checkoutId, sessionId),
    renameSession: (checkoutId, input) => ipcRenderer.invoke("phaseatlas:chat:sessions:rename", checkoutId, input),
    closeSession: (checkoutId, sessionId) => ipcRenderer.invoke("phaseatlas:chat:sessions:close", checkoutId, sessionId),
    listMessages: (checkoutId, sessionId) => ipcRenderer.invoke("phaseatlas:chat:messages:list", checkoutId, sessionId),
    listTurns: (checkoutId, sessionId) => ipcRenderer.invoke("phaseatlas:chat:turns:list", checkoutId, sessionId),
    send: (checkoutId, input) => ipcRenderer.invoke("phaseatlas:chat:turns:send", checkoutId, input),
    events: (checkoutId, turnId, afterSequence = 0, limit = 200) => ipcRenderer.invoke(
      "phaseatlas:chat:turns:events", checkoutId, turnId, afterSequence, limit,
    ),
    cancel: (checkoutId, turnId) => ipcRenderer.invoke("phaseatlas:chat:turns:cancel", checkoutId, turnId),
    retry: (checkoutId, input) => ipcRenderer.invoke("phaseatlas:chat:turns:retry", checkoutId, input),
    prepareEdit: (checkoutId, input) => ipcRenderer.invoke("phaseatlas:chat:edits:prepare", checkoutId, input),
    listEdits: (checkoutId, sessionId) => ipcRenderer.invoke("phaseatlas:chat:edits:list", checkoutId, sessionId),
    startEdit: (checkoutId, input) => ipcRenderer.invoke("phaseatlas:chat:edits:start", checkoutId, input),
    editEvents: (checkoutId, editId, afterSequence = 0, limit = 200) => ipcRenderer.invoke("phaseatlas:chat:edits:events", checkoutId, editId, afterSequence, limit),
    editResult: (checkoutId, editId) => ipcRenderer.invoke("phaseatlas:chat:edits:result", checkoutId, editId),
    cancelEdit: (checkoutId, editId) => ipcRenderer.invoke("phaseatlas:chat:edits:cancel", checkoutId, editId),
    acceptEdit: (checkoutId, editId) => ipcRenderer.invoke("phaseatlas:chat:edits:accept", checkoutId, editId),
    discardEdit: (checkoutId, editId) => ipcRenderer.invoke("phaseatlas:chat:edits:discard", checkoutId, editId),
    retainEdit: (checkoutId, editId) => ipcRenderer.invoke("phaseatlas:chat:edits:retain", checkoutId, editId),
    recoverEdit: (checkoutId, input) => ipcRenderer.invoke("phaseatlas:chat:edits:recover", checkoutId, input),
  },
  events: {
    subscribe: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: PhaseAtlasDesktopEvent) => listener(payload);
      ipcRenderer.on("phaseatlas:event", handler);
      return () => ipcRenderer.removeListener("phaseatlas:event", handler);
    },
  },
  runtime: {
    platform: () => ipcRenderer.invoke("phaseatlas:runtime:platform"),
    onCloseSurface: (listener) => {
      const handler = () => listener();
      ipcRenderer.on("phaseatlas:shortcut:close-surface", handler);
      return () => ipcRenderer.removeListener("phaseatlas:shortcut:close-surface", handler);
    },
  },
};

contextBridge.exposeInMainWorld("phaseatlas", api);
