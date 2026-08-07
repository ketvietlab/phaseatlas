import { contextBridge, ipcRenderer } from "electron";

type PhaseAtlasTheme = "light" | "dark";

// The IDE view is a sandboxed web surface like the renderer: it receives the
// current theme and nothing else. Leaving the IDE is PhaseAtlas chrome now, so
// nothing is injected into Theia's DOM and nothing here can close anything.
const initialTheme: PhaseAtlasTheme = ipcRenderer.sendSync("phaseatlas:ide:theme:get") === "dark" ? "dark" : "light";
let currentTheme: PhaseAtlasTheme = initialTheme;
const themeCallbacks = new Set<(theme: PhaseAtlasTheme) => void>();

ipcRenderer.on("phaseatlas:ide:theme-changed", (_event, theme: unknown) => {
  if (theme !== "light" && theme !== "dark") return;
  currentTheme = theme;
  for (const callback of themeCallbacks) callback(theme);
});

const api = Object.freeze({
  getTheme: () => currentTheme,
  onThemeChanged: (callback: (theme: PhaseAtlasTheme) => void) => {
    themeCallbacks.add(callback);
  },
});

contextBridge.exposeInMainWorld("phaseatlasIde", api);
