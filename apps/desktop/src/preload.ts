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
  events: {
    subscribe: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: PhaseAtlasDesktopEvent) => listener(payload);
      ipcRenderer.on("phaseatlas:event", handler);
      return () => ipcRenderer.removeListener("phaseatlas:event", handler);
    },
  },
  runtime: {
    platform: () => ipcRenderer.invoke("phaseatlas:runtime:platform"),
  },
};

contextBridge.exposeInMainWorld("phaseatlas", api);
