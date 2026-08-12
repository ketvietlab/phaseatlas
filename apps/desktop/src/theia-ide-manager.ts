import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { BrowserWindow, WebContentsView, shell } from "electron";
import type {
  IdeAgentConfiguration,
  IdeSurfaceState,
  IdeSurfaceTarget,
} from "@phaseatlas/contracts";
import {
  assertTheiaLaunchIdentity,
  isAllowedTheiaNavigation,
  theiaBackendArguments,
  theiaPortForTarget,
  theiaTargetKey,
  type IdeViewportRect,
  type PhaseAtlasTheme,
  type TheiaTarget,
} from "./theia-ide-policy.js";
import {
  PHASEATLAS_THEIA_BACKGROUND_COLORS,
  phaseAtlasTheiaThemeId,
} from "./theia-theme.js";

const STARTUP_TIMEOUT_MS = 20_000;
const DIAGNOSTIC_LIMIT = 4_000;
const PHASEATLAS_THEIA_DEFAULTS = {
  "ai-features.AiEnable.enableAI": true,
  "ai-features.chat.bypassModelRequirement": true,
  "ai-features.chat.defaultChatAgent": "Codex",
  "editor.minimap.enabled": false,
  "extensions.ignoreRecommendations": true,
  "files.autoSave": "afterDelay",
  "git.autoRepositoryDetection": true,
  "git.openRepositoryInParentFolders": "always",
  "mdx.server.enable": false,
  "workbench.editor.closeOnFileDelete": true,
  "workbench.startupEditor": "none",
} as const;
interface TheiaInstance {
  key: string;
  target: TheiaTarget;
  checkoutId: string;
  repositoryPath: string;
  configPath: string;
  title: string;
  port: number;
  process: ChildProcessByStdio<null, Readable, Readable>;
  stderrTail: string;
  stopping: boolean;
  theme: PhaseAtlasTheme;
  host: BrowserWindow;
  visible: boolean;
  startupError?: Error;
  view?: WebContentsView;
}

const THEIA_AGENT_IDS = {
  "codex-cli": "Codex",
  "claude-code": "ClaudeCode",
} as const;

function theiaAgentId(configuration: IdeAgentConfiguration | undefined): "Codex" | "ClaudeCode" {
  return configuration?.agents.find((agent) => agent.runnerId === configuration.runnerId)?.theiaAgentId ?? "Codex";
}

// Electron drops the webContents reference once the view is gone, so reaching
// straight through `view.webContents` throws on a crashed or closed IDE rather
// than reporting it. Every access goes through here instead.
function liveContents(view: WebContentsView | undefined): Electron.WebContents | undefined {
  const contents = view?.webContents as Electron.WebContents | undefined;
  return contents && !contents.isDestroyed() ? contents : undefined;
}

async function seedTheiaSettings(
  configPath: string,
  claudeCodePath: string,
  theme: PhaseAtlasTheme,
  configuration?: IdeAgentConfiguration,
): Promise<void> {
  const defaults = {
    ...PHASEATLAS_THEIA_DEFAULTS,
    "ai-features.chat.defaultChatAgent": theiaAgentId(configuration),
    "ai-features.claudeCode.executablePath": claudeCodePath,
    "workbench.colorTheme": phaseAtlasTheiaThemeId(theme),
  } as const;
  const settingsPath = path.join(configPath, "settings.json");
  try {
    await writeFile(settingsPath, `${JSON.stringify(defaults, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Existing target settings belong to the user. Add missing product defaults
    // without replacing explicit values or rewriting the rest of their JSONC.
    let current = await readFile(settingsPath, "utf8");
    const missing = Object.entries(defaults).filter(([key]) => {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return !new RegExp(`^[\\t ]*["']${escaped}["'][\\t ]*:`, "m").test(current);
    });
    if (!missing.length) return;
    const closingBrace = current.lastIndexOf("}");
    if (closingBrace < 0) return;
    const before = current.slice(0, closingBrace).trimEnd();
    const separator = before.endsWith("{") ? "\n" : ",\n";
    const additions = missing.map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(",\n");
    const updated = `${before}${separator}${additions}\n}${current.slice(closingBrace + 1)}`;
    await writeFile(settingsPath, updated, { encoding: "utf8", mode: 0o600 });
  }
}

async function setTheiaColorTheme(configPath: string, theme: PhaseAtlasTheme): Promise<void> {
  const settingsPath = path.join(configPath, "settings.json");
  let current = await readFile(settingsPath, "utf8");
  const key = "workbench.colorTheme";
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const property = new RegExp(`(^[\\t ]*["']${escaped}["'][\\t ]*:[\\t ]*)(["'][^"']*["'])`, "m");
  const value = JSON.stringify(phaseAtlasTheiaThemeId(theme));
  if (property.test(current)) {
    current = current.replace(property, `$1${value}`);
  } else {
    const closingBrace = current.lastIndexOf("}");
    if (closingBrace < 0) throw new Error("The IDE settings file is invalid.");
    const before = current.slice(0, closingBrace).trimEnd();
    const separator = before.endsWith("{") ? "\n" : ",\n";
    current = `${before}${separator}  ${JSON.stringify(key)}: ${value}\n}${current.slice(closingBrace + 1)}`;
  }
  await writeFile(settingsPath, current, { encoding: "utf8", mode: 0o600 });
}

async function setTheiaDefaultAgent(configPath: string, agentId: "Codex" | "ClaudeCode"): Promise<void> {
  const settingsPath = path.join(configPath, "settings.json");
  let current = await readFile(settingsPath, "utf8");
  const key = "ai-features.chat.defaultChatAgent";
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const property = new RegExp(`(^[\\t ]*["']${escaped}["'][\\t ]*:[\\t ]*)(["'][^"']*["'])`, "m");
  if (property.test(current)) {
    current = current.replace(property, `$1${JSON.stringify(agentId)}`);
  } else {
    const closingBrace = current.lastIndexOf("}");
    if (closingBrace < 0) throw new Error("The IDE settings file is invalid.");
    const before = current.slice(0, closingBrace).trimEnd();
    const separator = before.endsWith("{") ? "\n" : ",\n";
    current = `${before}${separator}  ${JSON.stringify(key)}: ${JSON.stringify(agentId)}\n}${current.slice(closingBrace + 1)}`;
  }
  await writeFile(settingsPath, current, { encoding: "utf8", mode: 0o600 });
}

async function writeAgentConfiguration(configPath: string, configuration: IdeAgentConfiguration): Promise<void> {
  await writeFile(
    path.join(configPath, "phaseatlas-agent.json"),
    `${JSON.stringify({
      runnerId: configuration.runnerId,
      modelId: configuration.modelId,
      ...(configuration.reasoningEffort ? { reasoningEffort: configuration.reasoningEffort } : {}),
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

async function reserveTargetPort(target: TheiaTarget): Promise<number> {
  const port = theiaPortForTarget(target);
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => {
      reject(new Error(`The saved IDE port ${port} for this workspace is unavailable.`, { cause: error }));
    });
    // Theia binds 127.0.0.1. Reserving on "localhost" resolves to ::1 on this
    // platform and succeeds while IPv4 is taken, so the check passed and the
    // backend then died with EADDRINUSE.
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function backendIsReady(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: "/", timeout: 500 }, (response) => {
      response.resume();
      resolve(Boolean(response.statusCode && response.statusCode < 500));
    });
    request.once("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.once("error", () => resolve(false));
  });
}

async function waitForBackend(instance: TheiaInstance): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (instance.startupError) throw instance.startupError;
    if (instance.process.exitCode !== null || instance.process.signalCode !== null) {
      throw new Error(`Theia IDE stopped during startup.${instance.stderrTail ? ` ${instance.stderrTail.trim()}` : ""}`);
    }
    if (await backendIsReady(instance.port)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Theia IDE did not become ready before the startup deadline.");
}

export class TheiaIdeManager {
  private readonly instances = new Map<string, TheiaInstance>();
  private readonly starts = new Map<string, Promise<void>>();
  private readonly agentConfigurations = new Map<string, IdeAgentConfiguration>();
  private readonly viewports = new WeakMap<BrowserWindow, IdeViewportRect>();
  private readonly hosts = new Set<BrowserWindow>();

  constructor(
    private readonly backendEntry: string,
    private readonly preloadEntry: string,
    private readonly defaultExtensionsRoot: string,
    private readonly claudeCodePath: string,
    private readonly codexSdkPath: string,
    private readonly codexExecutablePath: string,
    private readonly runtimeRoot: string,
    private readonly publishState: (host: BrowserWindow, state: IdeSurfaceState) => void,
    private readonly requestLeave: (host: BrowserWindow) => void,
  ) {}

  async open(
    target: TheiaTarget,
    repositoryPath: string,
    title: string,
    theme: PhaseAtlasTheme,
    host: BrowserWindow,
  ): Promise<IdeSurfaceState> {
    assertTheiaLaunchIdentity(target.checkoutId, repositoryPath);
    const key = theiaTargetKey(target);
    const existing = this.instances.get(key);
    if (existing) {
      if (existing.repositoryPath !== repositoryPath) {
        throw new Error("The IDE workspace path no longer matches its registered identity.");
      }
      await this.applyTheme(existing, theme);
      return this.show(host, key);
    }
    // Two clicks before the backend is ready must not spawn two backends.
    const pending = this.starts.get(key);
    if (pending) {
      await pending;
      return this.show(host, key);
    }
    const start = this.start(target, repositoryPath, title, theme, host);
    this.starts.set(key, start);
    try {
      await start;
    } finally {
      this.starts.delete(key);
    }
    return this.show(host, key);
  }

  // Switching hides a view rather than tearing it down: the Theia backend keeps
  // its editors, terminals and language servers, so coming back is immediate.
  show(host: BrowserWindow, key: string): IdeSurfaceState {
    const instance = this.instances.get(key);
    if (!instance || instance.host !== host) throw new Error("That IDE workspace is not open.");
    for (const candidate of this.instances.values()) {
      if (candidate.host === host) candidate.visible = candidate.key === key;
    }
    this.layout(host);
    liveContents(instance.view)?.focus();
    return this.state(host);
  }

  hide(host: BrowserWindow): IdeSurfaceState {
    for (const instance of this.instances.values()) {
      if (instance.host === host) instance.visible = false;
    }
    this.layout(host);
    if (!host.isDestroyed()) host.webContents.focus();
    return this.state(host);
  }

  close(host: BrowserWindow, key: string): IdeSurfaceState {
    const instance = this.instances.get(key);
    if (!instance || instance.host !== host) throw new Error("That IDE workspace is not open.");
    this.stop(key);
    if (!host.isDestroyed()) host.webContents.focus();
    return this.state(host);
  }

  state(host: BrowserWindow): IdeSurfaceState {
    const targets: IdeSurfaceTarget[] = [];
    let visibleKey: string | null = null;
    for (const instance of this.instances.values()) {
      if (instance.host !== host) continue;
      targets.push({
        key: instance.key,
        checkoutId: instance.checkoutId,
        ...(instance.target.leaseId ? { leaseId: instance.target.leaseId } : {}),
        kind: instance.target.kind === "tasks" ? "tasks" : instance.target.leaseId ? "run" : "code",
        title: instance.title,
      });
      if (instance.visible) visibleKey = instance.key;
    }
    return { targets, visibleKey };
  }

  setViewport(host: BrowserWindow, rect: IdeViewportRect): IdeSurfaceState {
    // getBoundingClientRect() reports CSS pixels after page zoom, while a
    // WebContentsView expects device-independent window pixels. At 110% zoom,
    // using the CSS rectangle directly shrinks and shifts Theia by roughly 9%,
    // leaving PhaseAtlas visible along the right and bottom edges.
    const zoom = host.webContents.getZoomFactor();
    const left = Math.round(rect.x * zoom);
    const top = Math.round(rect.y * zoom);
    const right = Math.round((rect.x + rect.width) * zoom);
    const bottom = Math.round((rect.y + rect.height) * zoom);
    this.viewports.set(host, {
      x: left,
      y: top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    });
    this.layout(host);
    return this.state(host);
  }

  stopAll(): void {
    for (const key of [...this.instances.keys()]) this.stop(key);
  }

  themeForWebContents(webContentsId: number): PhaseAtlasTheme {
    for (const instance of this.instances.values()) {
      if (liveContents(instance.view)?.id === webContentsId) return instance.theme;
    }
    return "light";
  }

  async setTheme(theme: PhaseAtlasTheme): Promise<void> {
    await Promise.all([...this.instances.values()].map((instance) => this.applyTheme(instance, theme)));
  }

  checkoutForWebContents(webContentsId: number): { checkoutId: string; host: BrowserWindow; kind: "code" | "run" | "tasks" } | undefined {
    for (const instance of this.instances.values()) {
      if (liveContents(instance.view)?.id === webContentsId) {
        return {
          checkoutId: instance.checkoutId,
          host: instance.host,
          kind: instance.target.kind === "tasks" ? "tasks" : instance.target.leaseId ? "run" : "code",
        };
      }
    }
    return undefined;
  }

  agentConfigurationForWebContents(webContentsId: number): IdeAgentConfiguration | undefined {
    const target = this.checkoutForWebContents(webContentsId);
    return target ? this.agentConfigurations.get(target.checkoutId) : undefined;
  }

  async setAgentConfiguration(checkoutId: string, configuration: IdeAgentConfiguration): Promise<void> {
    if (!THEIA_AGENT_IDS[configuration.runnerId as keyof typeof THEIA_AGENT_IDS]) {
      throw new Error("That repository runner is not supported by the embedded IDE.");
    }
    this.agentConfigurations.set(checkoutId, configuration);
    const writes: Promise<void>[] = [];
    for (const instance of this.instances.values()) {
      if (instance.checkoutId !== checkoutId) continue;
      const contents = liveContents(instance.view);
      writes.push(Promise.all([
        writeAgentConfiguration(instance.configPath, configuration),
        setTheiaDefaultAgent(instance.configPath, theiaAgentId(configuration)),
      ]).then(() => {
        if (contents && !contents.isDestroyed()) {
          contents.send("phaseatlas:ide:agent:configuration", configuration);
        }
      }));
    }
    await Promise.all(writes);
  }

  async openChat(host: BrowserWindow): Promise<void> {
    const instance = [...this.instances.values()].find((candidate) => candidate.host === host && candidate.visible);
    const contents = liveContents(instance?.view);
    if (!instance || !contents) throw new Error("Open an IDE workspace before opening AI Chat.");

    // loadURL resolves before the Theia frontend contributions have necessarily
    // registered their keybindings. Wait for the application shell so a first
    // click on a cold workspace cannot disappear into the splash screen.
    let frontendReady = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      frontendReady = await contents.executeJavaScript(
        "Boolean(document.getElementById('theia-app-shell') && !document.querySelector('.theia-preload:not(.theia-hidden)'))",
        true,
      ) as boolean;
      if (frontendReady) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!frontendReady) throw new Error("Theia is still starting. Try opening AI Chat again.");

    // The command is fixed and bounded: the PhaseAtlas renderer cannot execute
    // arbitrary Theia commands or JavaScript. If Chat is already visible, keep
    // it open; otherwise invoke Theia's documented AI Chat toggle keybinding.
    const chatVisible = await contents.executeJavaScript(
      "Boolean(document.getElementById('chat-view-widget')?.getClientRects().length)",
      true,
    ) as boolean;
    if (!chatVisible) {
      const modifiers: Electron.InputEvent["modifiers"] = process.platform === "darwin"
        ? ["control", "meta"]
        : ["control", "alt"];
      contents.sendInputEvent({ type: "keyDown", keyCode: "I", modifiers });
      contents.sendInputEvent({ type: "keyUp", keyCode: "I", modifiers });
    }
    contents.focus();
  }

  private async start(
    target: TheiaTarget,
    repositoryPath: string,
    title: string,
    theme: PhaseAtlasTheme,
    host: BrowserWindow,
  ): Promise<void> {
    await Promise.all([
      access(this.backendEntry),
      access(this.preloadEntry),
      access(this.defaultExtensionsRoot),
      access(this.claudeCodePath),
      access(this.codexSdkPath),
      access(this.codexExecutablePath),
    ]);
    const checkoutId = target.checkoutId;
    const key = theiaTargetKey(target);
    // Config and plugins are per target, or two workspaces overwrite each other.
    const checkoutRuntime = target.kind === "tasks"
      ? path.join(this.runtimeRoot, "checkouts", checkoutId, "ide-tasks")
      : target.leaseId
      ? path.join(this.runtimeRoot, "checkouts", checkoutId, "ide-worktrees", target.leaseId)
      : path.join(this.runtimeRoot, "checkouts", checkoutId, "ide");
    const configPath = path.join(checkoutRuntime, "config");
    const pluginsPath = path.join(checkoutRuntime, "plugins");
    await Promise.all([
      mkdir(configPath, { recursive: true, mode: 0o700 }),
      mkdir(pluginsPath, { recursive: true, mode: 0o700 }),
    ]);
    // A fresh embedded workspace should feel like part of PhaseAtlas, not the
    // generic Theia example: start directly in the source tree and suppress the
    // extension recommendation toast. Existing user settings always win.
    const agentConfiguration = this.agentConfigurations.get(checkoutId);
    await seedTheiaSettings(configPath, this.claudeCodePath, theme, agentConfiguration);
    await setTheiaColorTheme(configPath, theme);
    if (agentConfiguration) {
      await Promise.all([
        writeAgentConfiguration(configPath, agentConfiguration),
        setTheiaDefaultAgent(configPath, theiaAgentId(agentConfiguration)),
      ]);
    }
    const port = await reserveTargetPort(target);
    const child = spawn(process.execPath, [this.backendEntry, ...theiaBackendArguments(repositoryPath, port, pluginsPath)], {
      cwd: repositoryPath,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        THEIA_CONFIG_DIR: configPath,
        THEIA_DEFAULT_PLUGINS: `local-dir:${path.join(this.defaultExtensionsRoot, "plugins")}`,
        PHASEATLAS_AGENT_CONFIG_PATH: path.join(configPath, "phaseatlas-agent.json"),
        PHASEATLAS_CODEX_SDK_PATH: this.codexSdkPath,
        PHASEATLAS_CODEX_BIN: this.codexExecutablePath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const instance: TheiaInstance = {
      key,
      target,
      checkoutId,
      repositoryPath,
      configPath,
      title,
      port,
      process: child,
      stderrTail: "",
      stopping: false,
      theme,
      host,
      visible: false,
    };
    this.instances.set(key, instance);
    this.adoptHost(host);
    child.stdout.resume();
    child.once("error", (error) => {
      instance.startupError = error;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      instance.stderrTail = `${instance.stderrTail}${chunk}`.slice(-DIAGNOSTIC_LIMIT);
    });
    // A backend that dies on its own must not leave a dead tab in the switcher.
    child.once("exit", () => {
      if (this.instances.get(key) !== instance) return;
      this.stop(key);
      if (!host.isDestroyed()) this.publishState(host, this.state(host));
    });
    try {
      await waitForBackend(instance);
      if (this.instances.get(key) !== instance) throw new Error("Theia IDE stopped before its view could open.");
      if (host.isDestroyed()) throw new Error("The PhaseAtlas window closed before the IDE could open.");
      await this.createView(instance, host);
    } catch (error) {
      this.stop(key);
      throw error;
    }
  }

  private async createView(instance: TheiaInstance, host: BrowserWindow): Promise<void> {
    const partition = `persist:phaseatlas-theia-${instance.key.replace(":", "-")}`;
    const view = new WebContentsView({
      webPreferences: {
        preload: this.preloadEntry,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        partition,
      },
    });
    instance.view = view;
    view.setBackgroundColor(PHASEATLAS_THEIA_BACKGROUND_COLORS[instance.theme]);
    view.setVisible(false);
    view.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedTheiaNavigation(url, instance.port)) {
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            backgroundColor: PHASEATLAS_THEIA_BACKGROUND_COLORS[instance.theme],
            webPreferences: {
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
              webSecurity: true,
              partition,
            },
          },
        };
      }
      if (url.startsWith("https://")) void shell.openExternal(url);
      return { action: "deny" };
    });
    view.webContents.on("will-navigate", (event, url) => {
      if (!isAllowedTheiaNavigation(url, instance.port)) event.preventDefault();
    });
    // The panel header is the way back, but the IDE covers it while it has the
    // keyboard, so the keyboard needs its own escape that Theia never sees. The
    // view is hidden here and the renderer is asked to close the panel around
    // it, so a wedged renderer still cannot trap the user inside the IDE.
    view.webContents.on("before-input-event", (event, input) => {
      if (input.key.toLowerCase() !== "p" || !input.alt || !input.shift || input.control || input.meta) return;
      event.preventDefault();
      if (input.type !== "keyDown" || input.isAutoRepeat) return;
      const state = this.hide(host);
      if (host.isDestroyed()) return;
      this.publishState(host, state);
      this.requestLeave(host);
    });
    // A crashed IDE renderer leaves a live backend behind a blank rectangle;
    // tear the whole target down so the strip stops offering it.
    view.webContents.once("render-process-gone", () => {
      this.stop(instance.key);
      if (!host.isDestroyed()) this.publishState(host, this.state(host));
    });
    host.contentView.addChildView(view);
    this.layout(host);
    await view.webContents.loadURL(`http://localhost:${instance.port}`);
    const configuration = this.agentConfigurations.get(instance.checkoutId);
    if (configuration) view.webContents.send("phaseatlas:ide:agent:configuration", configuration);
  }

  private adoptHost(host: BrowserWindow): void {
    if (this.hosts.has(host)) return;
    this.hosts.add(host);
    const relayout = () => this.layout(host);
    host.on("resize", relayout);
    host.on("enter-full-screen", relayout);
    host.on("leave-full-screen", relayout);
    host.once("closed", () => {
      this.hosts.delete(host);
      for (const instance of [...this.instances.values()]) {
        if (instance.host === host) this.stop(instance.key);
      }
    });
  }

  // Bounds and visibility are decided together: a view with nowhere to go is
  // hidden rather than painted at whatever size it happened to be left with.
  private layout(host: BrowserWindow): void {
    if (host.isDestroyed()) return;
    const rect = this.viewports.get(host);
    for (const instance of this.instances.values()) {
      if (instance.host !== host || !liveContents(instance.view)) continue;
      const placed = Boolean(rect && rect.width > 0 && rect.height > 0);
      if (rect && placed) instance.view?.setBounds(rect);
      instance.view?.setVisible(instance.visible && placed);
    }
  }

  private async applyTheme(instance: TheiaInstance, theme: PhaseAtlasTheme): Promise<void> {
    instance.theme = theme;
    await setTheiaColorTheme(instance.configPath, theme);
    const contents = liveContents(instance.view);
    if (!contents) return;
    instance.view?.setBackgroundColor(PHASEATLAS_THEIA_BACKGROUND_COLORS[theme]);
    contents.send("phaseatlas:ide:theme-changed", theme);
  }

  private stop(key: string): void {
    const instance = this.instances.get(key);
    if (!instance || instance.stopping) return;
    instance.stopping = true;
    this.instances.delete(key);
    const view = instance.view;
    if (view) {
      if (!instance.host.isDestroyed()) instance.host.contentView.removeChildView(view);
      liveContents(view)?.close();
    }
    if (instance.process.exitCode !== null || instance.process.signalCode !== null) return;
    instance.process.kill("SIGTERM");
    const forceTimer = setTimeout(() => {
      if (instance.process.exitCode === null && instance.process.signalCode === null) {
        instance.process.kill("SIGKILL");
      }
    }, 2_000);
    forceTimer.unref();
  }
}
