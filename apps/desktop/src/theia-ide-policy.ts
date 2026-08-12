import path from "node:path";

export type PhaseAtlasTheme = "light" | "dark";

const CHECKOUT_ID_PATTERN = /^[a-f0-9]{20}$/;
const THEIA_PORT_BASE = 30_000;
const THEIA_PORT_RANGE = 20_000;

export function assertPhaseAtlasTheme(theme: string): asserts theme is PhaseAtlasTheme {
  if (theme !== "light" && theme !== "dark") throw new Error("The IDE theme is invalid.");
}

export function assertTheiaLaunchIdentity(checkoutId: string, repositoryPath: string): void {
  if (!CHECKOUT_ID_PATTERN.test(checkoutId)) throw new Error("The IDE checkout identity is invalid.");
  if (!path.isAbsolute(repositoryPath)) throw new Error("The IDE repository path must be canonical and absolute.");
}

const LEASE_ID_PATTERN = /^[a-f0-9-]{36}$/;

// The canonical checkout and each retained worktree are separate IDE targets:
// the checkout is the user's own copy, a worktree is what an agent produced.
// They must not share a window, a port or a config directory.
export interface TheiaTarget {
  checkoutId: string;
  leaseId?: string;
  kind?: "tasks";
}

export function theiaTargetKey(target: TheiaTarget): string {
  if (!CHECKOUT_ID_PATTERN.test(target.checkoutId)) throw new Error("The IDE checkout identity is invalid.");
  if (target.kind === "tasks") {
    if (target.leaseId !== undefined) throw new Error("The task registry target cannot be a run worktree.");
    return `${target.checkoutId}:tasks`;
  }
  if (target.leaseId === undefined) return target.checkoutId;
  if (!LEASE_ID_PATTERN.test(target.leaseId)) throw new Error("The IDE worktree identity is invalid.");
  return `${target.checkoutId}:${target.leaseId}`;
}

// One stable port per target, derived rather than allocated, so reopening a
// repository or a worktree reaches the same backend instead of leaking one.
export function theiaPortForTarget(target: TheiaTarget): number {
  const key = theiaTargetKey(target);
  let hash = 0;
  for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return THEIA_PORT_BASE + hash % THEIA_PORT_RANGE;
}

// The IDE is a native view painted over the body of a PhaseAtlas panel, so only
// the renderer knows where it belongs: it measures the panel and reports the
// rectangle in window-content coordinates. Until it does, the view stays hidden
// rather than guessing and flashing at the wrong size.
export interface IdeViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MAX_VIEWPORT_EXTENT = 32_000;

export function assertIdeViewport(value: unknown): asserts value is IdeViewportRect {
  const rect = value as Partial<IdeViewportRect> | null;
  if (!rect || typeof rect !== "object") throw new Error("The IDE viewport is invalid.");
  for (const key of ["x", "y", "width", "height"] as const) {
    const side = rect[key];
    if (typeof side !== "number" || !Number.isFinite(side) || Math.abs(side) > MAX_VIEWPORT_EXTENT) {
      throw new Error("The IDE viewport is invalid.");
    }
  }
  if ((rect.width as number) < 0 || (rect.height as number) < 0) {
    throw new Error("The IDE viewport is invalid.");
  }
}

export function theiaBackendArguments(repositoryPath: string, port: number, pluginsPath: string): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("The IDE port is invalid.");
  if (!path.isAbsolute(pluginsPath)) throw new Error("The IDE plugin path must be absolute.");
  return [
    repositoryPath,
    "--hostname=localhost",
    `--port=${port}`,
    `--plugins=local-dir:${pluginsPath}`,
    "--plugin-max-session-logs-folders=5",
  ];
}

// The IDE window may only reach its own backend. Theia serves webviews from
// subdomains of localhost, so those are allowed; anything else is not.
export function isAllowedTheiaNavigation(rawUrl: string, port: number): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" || url.port !== String(port)) return false;
  return url.hostname === "localhost" || url.hostname.endsWith(".webview.localhost");
}

const THEIA_CLIPBOARD_PERMISSIONS = new Set([
  "clipboard-read",
  "clipboard-sanitized-write",
  "deprecated-sync-clipboard-read",
]);

// The embedded IDE needs clipboard reads for Monaco, the terminal and AI Chat.
// Scope that exception to the target's loopback origin; every unrelated
// browser permission remains denied by the session handlers in the manager.
export function isAllowedTheiaClipboardPermission(
  permission: string,
  requestingUrl: string | undefined,
  port: number,
): boolean {
  return Boolean(
    THEIA_CLIPBOARD_PERMISSIONS.has(permission) &&
    requestingUrl &&
    isAllowedTheiaNavigation(requestingUrl, port),
  );
}
