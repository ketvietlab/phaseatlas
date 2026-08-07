import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { access, mkdir } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { BrowserWindow, shell } from "electron";
import {
  assertTheiaLaunchIdentity,
  isAllowedTheiaNavigation,
  theiaBackendArguments,
  theiaPortForCheckout,
  type PhaseAtlasTheme,
} from "./theia-ide-policy.js";

const STARTUP_TIMEOUT_MS = 20_000;
const DIAGNOSTIC_LIMIT = 4_000;
const CLOSE_BUTTON_ID = "phaseatlas-ide-close";

const CLOSE_BUTTON_CSS = `
  #theia-top-panel { padding-right: 52px !important; }
  #${CLOSE_BUTTON_ID} {
    position: fixed;
    top: max(2px, env(safe-area-inset-top));
    right: max(6px, env(safe-area-inset-right));
    z-index: 2147483647;
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    padding: 0 0 2px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    color: var(--theia-titleBar-activeForeground, currentColor);
    font: 400 22px/1 Inter, ui-sans-serif, system-ui, sans-serif;
    cursor: default;
    -webkit-app-region: no-drag;
    transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  #${CLOSE_BUTTON_ID}:hover {
    border-color: var(--theia-titleBar-border, currentColor);
    background: var(--theia-toolbar-hoverBackground, var(--theia-list-hoverBackground, transparent));
  }
  #${CLOSE_BUTTON_ID}:focus-visible {
    outline: 2px solid var(--theia-focusBorder, #637ad5);
    outline-offset: -2px;
  }
`;

// Theia owns its own chrome, so PhaseAtlas injects the one control it needs:
// a way back out of the IDE.
function closeButtonBootstrap(): string {
  return `(() => {
    const buttonId = ${JSON.stringify(CLOSE_BUTTON_ID)};
    const styleId = "phaseatlas-ide-window-controls";
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = ${JSON.stringify(CLOSE_BUTTON_CSS)};
      document.head.append(style);
    }
    if (!document.getElementById(buttonId)) {
      const button = document.createElement("button");
      button.id = buttonId;
      button.type = "button";
      button.setAttribute("aria-label", "Close PhaseAtlas IDE");
      button.title = "Close IDE";
      button.textContent = "×";
      button.addEventListener("click", () => {
        const request = new CustomEvent("phaseatlas:ide:request-close", { cancelable: true });
        if (window.dispatchEvent(request)) window.phaseatlasIde?.close();
      });
      document.body.append(button);
    }
  })();`;
}

interface TheiaInstance {
  checkoutId: string;
  repositoryPath: string;
  port: number;
  process: ChildProcessByStdio<null, Readable, Readable>;
  stderrTail: string;
  stopping: boolean;
  theme: PhaseAtlasTheme;
  startupError?: Error;
  window?: BrowserWindow;
}

export interface TheiaOpenResult {
  checkoutId: string;
  opened: true;
  reused: boolean;
}

async function reserveCheckoutPort(checkoutId: string): Promise<number> {
  const port = theiaPortForCheckout(checkoutId);
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => {
      reject(new Error(`The saved IDE port ${port} for this checkout is unavailable.`, { cause: error }));
    });
    server.listen(port, "localhost", () => {
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function backendIsReady(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get({ hostname: "localhost", port, path: "/", timeout: 500 }, (response) => {
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
  private readonly starts = new Map<string, Promise<TheiaOpenResult>>();

  constructor(
    private readonly backendEntry: string,
    private readonly preloadEntry: string,
    private readonly defaultExtensionsRoot: string,
    private readonly runtimeRoot: string,
  ) {}

  async open(
    checkoutId: string,
    repositoryPath: string,
    repositoryName: string,
    theme: PhaseAtlasTheme,
    ownerWindow?: BrowserWindow,
  ): Promise<TheiaOpenResult> {
    assertTheiaLaunchIdentity(checkoutId, repositoryPath);
    const existing = this.instances.get(checkoutId);
    if (existing) {
      if (existing.repositoryPath !== repositoryPath) {
        throw new Error("The IDE checkout path no longer matches its registered identity.");
      }
      this.applyTheme(existing, theme);
      if (ownerWindow && !ownerWindow.isDestroyed() && existing.window && !existing.window.isDestroyed()) {
        existing.window.setBounds(ownerWindow.getBounds(), false);
      }
      existing.window?.show();
      existing.window?.focus();
      return { checkoutId, opened: true, reused: true };
    }
    // Two clicks before the backend is ready must not spawn two backends.
    const pending = this.starts.get(checkoutId);
    if (pending) {
      const result = await pending;
      const pendingInstance = this.instances.get(checkoutId);
      if (pendingInstance) this.applyTheme(pendingInstance, theme);
      const pendingWindow = pendingInstance?.window;
      if (ownerWindow && !ownerWindow.isDestroyed() && pendingWindow && !pendingWindow.isDestroyed()) {
        pendingWindow.setBounds(ownerWindow.getBounds(), false);
      }
      pendingWindow?.focus();
      return { ...result, opened: true, reused: true };
    }
    const start = this.start(checkoutId, repositoryPath, repositoryName, theme, ownerWindow);
    this.starts.set(checkoutId, start);
    try {
      return await start;
    } finally {
      this.starts.delete(checkoutId);
    }
  }

  stopAll(): void {
    for (const [checkoutId, instance] of [...this.instances]) {
      if (instance.window && !instance.window.isDestroyed()) instance.window.close();
      else this.stop(checkoutId);
    }
  }

  closeForWebContents(webContentsId: number): boolean {
    for (const instance of this.instances.values()) {
      if (instance.window?.webContents.id !== webContentsId) continue;
      instance.window.close();
      return true;
    }
    return false;
  }

  themeForWebContents(webContentsId: number): PhaseAtlasTheme {
    for (const instance of this.instances.values()) {
      if (instance.window?.webContents.id === webContentsId) return instance.theme;
    }
    return "light";
  }

  setTheme(theme: PhaseAtlasTheme): void {
    for (const instance of this.instances.values()) this.applyTheme(instance, theme);
  }

  private async start(
    checkoutId: string,
    repositoryPath: string,
    repositoryName: string,
    theme: PhaseAtlasTheme,
    ownerWindow?: BrowserWindow,
  ): Promise<TheiaOpenResult> {
    await Promise.all([
      access(this.backendEntry),
      access(this.preloadEntry),
      access(this.defaultExtensionsRoot),
    ]);
    const checkoutRuntime = path.join(this.runtimeRoot, "checkouts", checkoutId);
    const configPath = path.join(checkoutRuntime, "config");
    const pluginsPath = path.join(checkoutRuntime, "plugins");
    await Promise.all([
      mkdir(configPath, { recursive: true, mode: 0o700 }),
      mkdir(pluginsPath, { recursive: true, mode: 0o700 }),
    ]);
    const port = await reserveCheckoutPort(checkoutId);
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
      checkoutId,
      repositoryPath,
      port,
      process: child,
      stderrTail: "",
      stopping: false,
      theme,
    };
    this.instances.set(checkoutId, instance);
    child.stdout.resume();
    child.once("error", (error) => {
      instance.startupError = error;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      instance.stderrTail = `${instance.stderrTail}${chunk}`.slice(-DIAGNOSTIC_LIMIT);
    });
    child.once("exit", () => {
      if (this.instances.get(checkoutId) === instance) this.instances.delete(checkoutId);
      if (!instance.window?.isDestroyed()) instance.window?.destroy();
    });
    try {
      await waitForBackend(instance);
      if (this.instances.get(checkoutId) !== instance) throw new Error("Theia IDE stopped before its window could open.");
      instance.window = await this.createWindow(instance, repositoryName, ownerWindow);
      return { checkoutId, opened: true, reused: false };
    } catch (error) {
      this.stop(checkoutId);
      throw error;
    }
  }

  private async createWindow(
    instance: TheiaInstance,
    repositoryName: string,
    ownerWindow?: BrowserWindow,
  ): Promise<BrowserWindow> {
    const origin = `http://localhost:${instance.port}`;
    const owner = ownerWindow && !ownerWindow.isDestroyed() ? ownerWindow : undefined;
    const initialBounds = owner?.getBounds() ?? { width: 1480, height: 940 };
    const window = new BrowserWindow({
      ...initialBounds,
      minWidth: 920,
      minHeight: 640,
      show: false,
      ...(owner ? { parent: owner } : {}),
      title: `${repositoryName} — PhaseAtlas IDE`,
      backgroundColor: instance.theme === "dark" ? "#2e3034" : "#ffffff",
      frame: process.platform !== "darwin",
      webPreferences: {
        preload: this.preloadEntry,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        partition: `persist:phaseatlas-theia-${instance.checkoutId}`,
      },
    });
    instance.window = window;
    window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    window.webContents.setWindowOpenHandler(({ url }) => {
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
              partition: `persist:phaseatlas-theia-${instance.checkoutId}`,
            },
          },
        };
      }
      if (url.startsWith("https://")) void shell.openExternal(url);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (!isAllowedTheiaNavigation(url, instance.port)) event.preventDefault();
    });
    window.webContents.on("did-finish-load", () => {
      void window.webContents.executeJavaScript(closeButtonBootstrap(), true).catch(() => undefined);
    });
    const fitToOwner = () => {
      if (owner && !owner.isDestroyed() && !window.isDestroyed()) window.setBounds(owner.getBounds(), false);
    };
    const ownerClosed = () => this.stop(instance.checkoutId);
    owner?.on("move", fitToOwner);
    owner?.on("resize", fitToOwner);
    owner?.once("closed", ownerClosed);
    window.once("ready-to-show", () => {
      fitToOwner();
      window.show();
    });
    window.once("closed", () => {
      owner?.removeListener("move", fitToOwner);
      owner?.removeListener("resize", fitToOwner);
      owner?.removeListener("closed", ownerClosed);
      this.stop(instance.checkoutId);
    });
    await window.loadURL(origin);
    return window;
  }

  private applyTheme(instance: TheiaInstance, theme: PhaseAtlasTheme): void {
    instance.theme = theme;
    if (!instance.window || instance.window.isDestroyed()) return;
    instance.window.setBackgroundColor(theme === "dark" ? "#2e3034" : "#ffffff");
    instance.window.webContents.send("phaseatlas:ide:theme-changed", theme);
  }

  private stop(checkoutId: string): void {
    const instance = this.instances.get(checkoutId);
    if (!instance || instance.stopping) return;
    instance.stopping = true;
    this.instances.delete(checkoutId);
    if (!instance.window?.isDestroyed()) instance.window?.destroy();
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
