import { fileURLToPath } from "node:url";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { RepositoryProcessManager } from "./repository-process-manager.js";

app.setName("PhaseAtlas");
app.setPath("userData", path.join(app.getPath("appData"), app.name));

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const workerEntry = process.env.PHASEATLAS_WORKER_ENTRY ||
  (app.isPackaged
    ? path.join(process.resourcesPath, "repository-worker", "index.js")
    : path.resolve(currentDirectory, "../../repository-worker/dist/index.js"));
const applicationSupportRoot = path.join(app.getPath("userData"), "runtime");
const repositories = new RepositoryProcessManager(workerEntry, applicationSupportRoot, (event) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("phaseatlas:event", event);
  }
});

function createWindow(): BrowserWindow {
  const developmentUrl = process.env.PHASEATLAS_UI_DEV_URL;
  const window = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 920,
    minHeight: 640,
    backgroundColor: "#111714",
    show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(currentDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, navigationUrl) => {
    const internalNavigation = developmentUrl
      ? new URL(navigationUrl).origin === new URL(developmentUrl).origin
      : navigationUrl.startsWith("file://");
    if (!internalNavigation) event.preventDefault();
  });
  window.once("ready-to-show", () => window.show());
  const webContentsId = window.webContents.id;
  window.webContents.once("destroyed", () => repositories.releaseViewsForWebContents(webContentsId));

  if (developmentUrl) void window.loadURL(developmentUrl);
  else void window.loadFile(path.resolve(currentDirectory, "../../ui/build/index.html"));

  return window;
}

function registerIpc(): void {
  ipcMain.handle("phaseatlas:runtime:platform", () => process.platform);
  ipcMain.handle("phaseatlas:repositories:list", () => repositories.list());
  ipcMain.handle("phaseatlas:repositories:refresh", (event, checkoutId: string) => {
    return repositories.refresh(checkoutId, event.sender.id);
  });
  ipcMain.handle("phaseatlas:repositories:open", async (event) => {
    const result = await dialog.showOpenDialog({
      title: "Open a repository in PhaseAtlas",
      buttonLabel: "Open repository",
      properties: ["openDirectory"],
    });
    const selectedPath = result.filePaths[0];
    if (result.canceled || !selectedPath) return null;
    return repositories.open(selectedPath, event.sender.id);
  });
  ipcMain.handle("phaseatlas:repositories:close", (event, checkoutId: string) => {
    repositories.close(checkoutId, event.sender.id);
  });
  ipcMain.handle("phaseatlas:workspaces:list", (_event, checkoutId: string) => {
    return repositories.listWorkspaces(checkoutId);
  });
  ipcMain.handle("phaseatlas:tasks:snapshot", (_event, checkoutId: string) => {
    return repositories.taskSnapshot(checkoutId);
  });
  ipcMain.handle("phaseatlas:tasks:content:list", (_event, checkoutId: string) => {
    return repositories.listTaskContentRuns(checkoutId);
  });
  ipcMain.handle("phaseatlas:tasks:content:start", (_event, checkoutId: string, input) => {
    return repositories.startTaskContent(checkoutId, input);
  });
  ipcMain.handle("phaseatlas:tasks:content:cancel", (_event, checkoutId: string, runId: string) => {
    return repositories.cancelTaskContent(checkoutId, runId);
  });
  ipcMain.handle("phaseatlas:tasks:content:save", (_event, checkoutId: string, taskKey: string, body: string) => {
    return repositories.saveTaskContent(checkoutId, taskKey, body);
  });
  ipcMain.handle("phaseatlas:files:list", (_event, checkoutId: string, directory: string) => {
    return repositories.listFiles(checkoutId, directory);
  });
  ipcMain.handle("phaseatlas:files:read", (_event, checkoutId: string, filePath: string) => {
    return repositories.readFile(checkoutId, filePath);
  });
  ipcMain.handle("phaseatlas:files:save", (_event, checkoutId: string, filePath: string, content: string) => {
    return repositories.saveFile(checkoutId, filePath, content);
  });
  ipcMain.handle("phaseatlas:runners:list", (_event, checkoutId: string) => {
    return repositories.listRunners(checkoutId);
  });
  ipcMain.handle("phaseatlas:planning:start", (_event, checkoutId: string, input) => {
    return repositories.startPlanning(checkoutId, input);
  });
  ipcMain.handle("phaseatlas:planning:cancel", (_event, checkoutId: string, runId: string) => {
    return repositories.cancelPlanning(checkoutId, runId);
  });
  ipcMain.handle("phaseatlas:planning:publish", (_event, checkoutId: string, input) => {
    return repositories.publishProposals(checkoutId, input);
  });
  ipcMain.handle("phaseatlas:agent-runs:actions", (_event, checkoutId: string, input) => {
    return repositories.agentRunActions(checkoutId, input);
  });
  ipcMain.handle("phaseatlas:agent-runs:list", (_event, checkoutId: string, taskKey?: string) => {
    return repositories.listAgentRuns(checkoutId, taskKey);
  });
  ipcMain.handle("phaseatlas:agent-runs:start", (_event, checkoutId: string, input) => {
    return repositories.startAgentRun(checkoutId, input);
  });
  ipcMain.handle("phaseatlas:agent-runs:cancel", (_event, checkoutId: string, runId: string) => {
    return repositories.cancelAgentRun(checkoutId, runId);
  });
  ipcMain.handle("phaseatlas:agent-runs:events", (_event, checkoutId: string, runId: string, afterSequence = 0, limit = 200) => {
    return repositories.listRunEventPage(checkoutId, runId, afterSequence, limit);
  });
  ipcMain.handle("phaseatlas:agent-runs:result", (_event, checkoutId: string, runId: string) => {
    return repositories.agentRunResult(checkoutId, runId);
  });
  ipcMain.handle("phaseatlas:agent-runs:recover", (_event, checkoutId: string, input) => {
    return repositories.recoverAgentRun(checkoutId, input);
  });
  ipcMain.handle("phaseatlas:terminals:list", (_event, checkoutId: string) => {
    return repositories.listTerminals(checkoutId);
  });
  ipcMain.handle("phaseatlas:terminals:create", (_event, checkoutId: string, input) => {
    return repositories.createTerminal(checkoutId, input);
  });
  ipcMain.handle("phaseatlas:terminals:write", (_event, checkoutId: string, sessionId: string, data: string) => {
    return repositories.writeTerminal(checkoutId, sessionId, data);
  });
  ipcMain.handle("phaseatlas:terminals:resize", (_event, checkoutId: string, sessionId: string, cols: number, rows: number) => {
    return repositories.resizeTerminal(checkoutId, sessionId, cols, rows);
  });
  ipcMain.handle("phaseatlas:terminals:close", (_event, checkoutId: string, sessionId: string) => {
    return repositories.closeTerminal(checkoutId, sessionId);
  });
  ipcMain.handle("phaseatlas:chat:sessions:create", (_event, checkoutId: string, input) => {
    return repositories.createChatSession(checkoutId, input);
  });
  ipcMain.handle("phaseatlas:chat:sessions:list", (_event, checkoutId: string) => repositories.listChatSessions(checkoutId));
  ipcMain.handle("phaseatlas:chat:sessions:get", (_event, checkoutId: string, sessionId: string) => repositories.getChatSession(checkoutId, sessionId));
  ipcMain.handle("phaseatlas:chat:sessions:rename", (_event, checkoutId: string, input) => repositories.renameChatSession(checkoutId, input));
  ipcMain.handle("phaseatlas:chat:sessions:close", (_event, checkoutId: string, sessionId: string) => repositories.closeChatSession(checkoutId, sessionId));
  ipcMain.handle("phaseatlas:chat:messages:list", (_event, checkoutId: string, sessionId: string) => repositories.listChatMessages(checkoutId, sessionId));
  ipcMain.handle("phaseatlas:chat:turns:list", (_event, checkoutId: string, sessionId: string) => repositories.listChatTurns(checkoutId, sessionId));
  ipcMain.handle("phaseatlas:chat:turns:send", (_event, checkoutId: string, input) => repositories.sendChatTurn(checkoutId, input));
  ipcMain.handle("phaseatlas:chat:turns:events", (_event, checkoutId: string, turnId: string, afterSequence = 0, limit = 200) => repositories.listChatEvents(checkoutId, turnId, afterSequence, limit));
  ipcMain.handle("phaseatlas:chat:turns:cancel", (_event, checkoutId: string, turnId: string) => repositories.cancelChatTurn(checkoutId, turnId));
  ipcMain.handle("phaseatlas:chat:turns:retry", (_event, checkoutId: string, input) => repositories.retryChatTurn(checkoutId, input));
  ipcMain.handle("phaseatlas:chat:edits:prepare", (_event, checkoutId: string, input) => repositories.prepareChatEdit(checkoutId, input));
  ipcMain.handle("phaseatlas:chat:edits:list", (_event, checkoutId: string, sessionId?: string) => repositories.listChatEdits(checkoutId, sessionId));
  ipcMain.handle("phaseatlas:chat:edits:start", (_event, checkoutId: string, input) => repositories.startChatEdit(checkoutId, input));
  ipcMain.handle("phaseatlas:chat:edits:events", (_event, checkoutId: string, editId: string, afterSequence = 0, limit = 200) => repositories.listChatEditEvents(checkoutId, editId, afterSequence, limit));
  ipcMain.handle("phaseatlas:chat:edits:result", (_event, checkoutId: string, editId: string) => repositories.chatEditResult(checkoutId, editId));
  ipcMain.handle("phaseatlas:chat:edits:cancel", (_event, checkoutId: string, editId: string) => repositories.cancelChatEdit(checkoutId, editId));
  ipcMain.handle("phaseatlas:chat:edits:accept", (_event, checkoutId: string, editId: string) => repositories.acceptChatEdit(checkoutId, editId));
  ipcMain.handle("phaseatlas:chat:edits:discard", (_event, checkoutId: string, editId: string) => repositories.discardChatEdit(checkoutId, editId));
  ipcMain.handle("phaseatlas:chat:edits:retain", (_event, checkoutId: string, editId: string) => repositories.retainChatEdit(checkoutId, editId));
  ipcMain.handle("phaseatlas:chat:edits:recover", (_event, checkoutId: string, input) => repositories.recoverChatEdit(checkoutId, input));
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => repositories.stopAll());
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
