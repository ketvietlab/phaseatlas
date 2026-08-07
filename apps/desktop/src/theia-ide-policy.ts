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

// One stable port per checkout, derived rather than allocated, so reopening a
// repository reaches the same backend instead of leaking a new one each time.
export function theiaPortForCheckout(checkoutId: string): number {
  if (!CHECKOUT_ID_PATTERN.test(checkoutId)) throw new Error("The IDE checkout identity is invalid.");
  return THEIA_PORT_BASE + Number.parseInt(checkoutId.slice(0, 8), 16) % THEIA_PORT_RANGE;
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
