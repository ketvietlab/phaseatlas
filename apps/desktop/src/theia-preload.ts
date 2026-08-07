import { contextBridge, ipcRenderer } from "electron";

type PhaseAtlasTheme = "light" | "dark";

// The IDE window is a sandboxed web surface like the renderer: it receives a
// close signal and the current theme, and nothing else.
const initialTheme: PhaseAtlasTheme = ipcRenderer.sendSync("phaseatlas:ide:theme:get") === "dark" ? "dark" : "light";
let currentTheme: PhaseAtlasTheme = initialTheme;
const themeCallbacks = new Set<(theme: PhaseAtlasTheme) => void>();

ipcRenderer.on("phaseatlas:ide:theme-changed", (_event, theme: unknown) => {
  if (theme !== "light" && theme !== "dark") return;
  currentTheme = theme;
  for (const callback of themeCallbacks) callback(theme);
});

const api = Object.freeze({
  close: () => ipcRenderer.send("phaseatlas:ide:close"),
  getTheme: () => currentTheme,
  onThemeChanged: (callback: (theme: PhaseAtlasTheme) => void) => {
    themeCallbacks.add(callback);
  },
});

contextBridge.exposeInMainWorld("phaseatlasIde", api);
