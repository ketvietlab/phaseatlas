import type { PhaseAtlasDesktopApi } from "@phaseatlas/contracts";

declare global {
  interface Window {
    phaseatlas?: PhaseAtlasDesktopApi;
  }
}

export {};

