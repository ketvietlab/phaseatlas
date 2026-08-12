export type PhaseAtlasIdeTheme = "light" | "dark";

export const PHASEATLAS_THEIA_THEME_IDS = {
  light: "phaseatlas-light",
  dark: "phaseatlas-dark",
} as const satisfies Record<PhaseAtlasIdeTheme, string>;

export const PHASEATLAS_THEIA_BACKGROUND_COLORS = {
  light: "#ffffff",
  dark: "#2e3034",
} as const satisfies Record<PhaseAtlasIdeTheme, string>;

export function phaseAtlasTheiaThemeId(theme: PhaseAtlasIdeTheme): string {
  return PHASEATLAS_THEIA_THEME_IDS[theme];
}
