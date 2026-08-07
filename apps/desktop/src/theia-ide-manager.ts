import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { access, mkdir } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { BrowserWindow, WebContentsView, shell } from "electron";
import type { IdeSurfaceState, IdeSurfaceTarget } from "@phaseatlas/contracts";
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

const STARTUP_TIMEOUT_MS = 20_000;
const DIAGNOSTIC_LIMIT = 4_000;

interface TheiaInstance {
  key: string;
  target: TheiaTarget;
  checkoutId: string;
  repositoryPath: string;
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

// Electron drops the webContents reference once the view is gone, so reaching
// straight through `view.webContents` throws on a crashed or closed IDE rather
// than reporting it. Every access goes through here instead.
function liveContents(view: WebContentsView | undefined): Electron.WebContents | undefined {
  const contents = view?.webContents as Electron.WebContents | undefined;
  return contents && !contents.isDestroyed() ? contents : undefined;
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
  private readonly viewports = new WeakMap<BrowserWindow, IdeViewportRect>();
  private readonly hosts = new Set<BrowserWindow>();

  constructor(
    private readonly backendEntry: string,
    private readonly preloadEntry: string,
    private readonly defaultExtensionsRoot: string,
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
      this.applyTheme(existing, theme);
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
        title: instance.title,
      });
      if (instance.visible) visibleKey = instance.key;
    }
    return { targets, visibleKey };
  }

  setViewport(host: BrowserWindow, rect: IdeViewportRect): IdeSurfaceState {
    this.viewports.set(host, {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
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

  setTheme(theme: PhaseAtlasTheme): void {
    for (const instance of this.instances.values()) this.applyTheme(instance, theme);
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
    ]);
    const checkoutId = target.checkoutId;
    const key = theiaTargetKey(target);
    // Config and plugins are per target, or two workspaces overwrite each other.
    const checkoutRuntime = target.leaseId
      ? path.join(this.runtimeRoot, "checkouts", checkoutId, "ide-worktrees", target.leaseId)
      : path.join(this.runtimeRoot, "checkouts", checkoutId, "ide");
    const configPath = path.join(checkoutRuntime, "config");
    const pluginsPath = path.join(checkoutRuntime, "plugins");
    await Promise.all([
      mkdir(configPath, { recursive: true, mode: 0o700 }),
      mkdir(pluginsPath, { recursive: true, mode: 0o700 }),
    ]);
    const port = await reserveTargetPort(target);
    const child = spawn(process.execPath, [this.backendEntry, ...theiaBackendArguments(repositoryPath, port, pluginsPath)], {
      cwd: repositoryPath,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        THEIA_CONFIG_DIR: configPath,
        THEIA_DEFAULT_PLUGINS: `local-dir:${this.defaultExtensionsRoot}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const instance: TheiaInstance = {
      key,
      target,
      checkoutId,
      repositoryPath,
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
    view.setBackgroundColor(instance.theme === "dark" ? "#2e3034" : "#ffffff");
    view.setVisible(false);
    view.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedTheiaNavigation(url, instance.port)) {
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            backgroundColor: instance.theme === "dark" ? "#2e3034" : "#ffffff",
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

  private applyTheme(instance: TheiaInstance, theme: PhaseAtlasTheme): void {
    instance.theme = theme;
    const contents = liveContents(instance.view);
    if (!contents) return;
    instance.view?.setBackgroundColor(theme === "dark" ? "#2e3034" : "#ffffff");
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
