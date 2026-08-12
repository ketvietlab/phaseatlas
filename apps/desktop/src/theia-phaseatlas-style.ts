import {
  PHASEATLAS_THEIA_BACKGROUND_COLORS,
  phaseAtlasTheiaThemeId,
  type PhaseAtlasIdeTheme,
} from "./theia-theme.js";

export type { PhaseAtlasIdeTheme } from "./theia-theme.js";

const STYLE_ID = "phaseatlas-theia-style";

// Theia publishes its color registry as CSS custom properties. Keeping the
// integration at that public styling boundary avoids patching the pinned Theia
// runtime while giving the embedded surface the same tokens as PhaseAtlas.
const PHASEATLAS_THEIA_CSS = `
:root {
  --phaseatlas-brand-300: #9faee4;
  --phaseatlas-brand-500: #637ad5;
  --phaseatlas-brand-600: #5167c4;
  --phaseatlas-brand-700: #45579f;
  --phaseatlas-radius-xs: 4px;
  --phaseatlas-radius-sm: 6px;
  --phaseatlas-radius: 8px;
  --theia-ui-font-family: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif !important;
  --theia-ui-font-size0: 12px !important;
  --theia-ui-font-size1: 13px !important;
  --theia-ui-font-size2: 14px !important;
  --theia-ui-font-size3: 15px !important;
  --theia-private-sidebar-tab-width: 44px !important;
  --theia-private-sidebar-icon-size: 21px !important;
  --theia-private-horizontal-tab-height: 34px !important;
  --theia-horizontal-toolbar-height: 34px !important;
}

:root[data-phaseatlas-theme="light"] {
  color-scheme: light;
  --pa-canvas: #f7f5f5;
  --pa-surface: #ffffff;
  --pa-surface-soft: #f7f5f5;
  --pa-surface-raised: #ffffff;
  --pa-border: #dddcde;
  --pa-border-soft: #efedee;
  --pa-text: #24262a;
  --pa-text-muted: #5a5c5e;
  --pa-text-subtle: #717373;
  --pa-active: #eef0fb;
  --pa-active-text: #45579f;
  --pa-shadow: rgba(24, 24, 27, .10);
}

:root[data-phaseatlas-theme="dark"] {
  color-scheme: dark;
  --pa-canvas: #24262a;
  --pa-surface: #2e3034;
  --pa-surface-soft: #24262a;
  --pa-surface-raised: #44464a;
  --pa-border: #44464a;
  --pa-border-soft: #3a3c40;
  --pa-text: #f7f5f5;
  --pa-text-muted: #cccccd;
  --pa-text-subtle: #9a9ea2;
  --pa-active: #2f3a5f;
  --pa-active-text: #dde2f7;
  --pa-shadow: rgba(0, 0, 0, .34);
}

:root[data-phaseatlas-theme] {
  --theia-foreground: var(--pa-text) !important;
  --theia-descriptionForeground: var(--pa-text-subtle) !important;
  --theia-disabledForeground: var(--pa-text-subtle) !important;
  --theia-icon-foreground: var(--pa-text-muted) !important;
  --theia-focusBorder: var(--phaseatlas-brand-300) !important;
  --theia-widget-border: var(--pa-border) !important;
  --theia-contrastBorder: var(--pa-border) !important;
  --theia-editor-background: var(--pa-surface) !important;
  --theia-editor-foreground: var(--pa-text) !important;
  --theia-editorGroup-border: var(--pa-border) !important;
  --theia-editorGroupHeader-tabsBackground: var(--pa-canvas) !important;
  --theia-editorGroupHeader-tabsBorder: var(--pa-border) !important;
  --theia-editor-lineHighlightBackground: color-mix(in srgb, var(--pa-active) 66%, transparent) !important;
  --theia-editor-selectionBackground: color-mix(in srgb, var(--phaseatlas-brand-500) 35%, transparent) !important;
  --theia-editor-inactiveSelectionBackground: color-mix(in srgb, var(--phaseatlas-brand-500) 20%, transparent) !important;
  --theia-editorLineNumber-foreground: var(--pa-text-subtle) !important;
  --theia-editorLineNumber-activeForeground: var(--pa-active-text) !important;
  --theia-editorCursor-foreground: var(--phaseatlas-brand-500) !important;
  --theia-tab-activeBackground: var(--pa-surface) !important;
  --theia-tab-activeForeground: var(--pa-text) !important;
  --theia-tab-activeBorderTop: var(--phaseatlas-brand-500) !important;
  --theia-tab-inactiveBackground: var(--pa-canvas) !important;
  --theia-tab-inactiveForeground: var(--pa-text-muted) !important;
  --theia-tab-unfocusedInactiveForeground: var(--pa-text-subtle) !important;
  --theia-tab-border: var(--pa-border) !important;
  --theia-sideBar-background: var(--pa-canvas) !important;
  --theia-sideBar-foreground: var(--pa-text) !important;
  --theia-sideBar-border: var(--pa-border) !important;
  --theia-sideBarTitle-foreground: var(--pa-text-muted) !important;
  --theia-sideBarSectionHeader-background: var(--pa-canvas) !important;
  --theia-sideBarSectionHeader-foreground: var(--pa-text-muted) !important;
  --theia-sideBarSectionHeader-border: var(--pa-border) !important;
  --theia-activityBar-background: var(--pa-canvas) !important;
  --theia-activityBar-foreground: var(--pa-active-text) !important;
  --theia-activityBar-inactiveForeground: var(--pa-text-subtle) !important;
  --theia-activityBar-activeBackground: var(--pa-active) !important;
  --theia-activityBar-activeBorder: var(--phaseatlas-brand-500) !important;
  --theia-activityBar-border: var(--pa-border) !important;
  --theia-activityBarBadge-background: var(--phaseatlas-brand-600) !important;
  --theia-activityBarBadge-foreground: #ffffff !important;
  --theia-panel-background: var(--pa-surface) !important;
  --theia-panel-border: var(--pa-border) !important;
  --theia-panelTitle-activeForeground: var(--pa-text) !important;
  --theia-panelTitle-inactiveForeground: var(--pa-text-subtle) !important;
  --theia-panelTitle-activeBorder: var(--phaseatlas-brand-500) !important;
  --theia-statusBar-background: var(--phaseatlas-brand-600) !important;
  --theia-statusBar-foreground: #ffffff !important;
  --theia-statusBar-border: var(--phaseatlas-brand-700) !important;
  --theia-statusBarItem-hoverBackground: color-mix(in srgb, #ffffff 14%, transparent) !important;
  --theia-list-hoverBackground: var(--pa-surface-raised) !important;
  --theia-list-hoverForeground: var(--pa-text) !important;
  --theia-list-activeSelectionBackground: var(--pa-active) !important;
  --theia-list-activeSelectionForeground: var(--pa-active-text) !important;
  --theia-list-inactiveSelectionBackground: color-mix(in srgb, var(--pa-active) 72%, transparent) !important;
  --theia-list-inactiveSelectionForeground: var(--pa-active-text) !important;
  --theia-list-focusOutline: var(--phaseatlas-brand-300) !important;
  --theia-input-background: var(--pa-surface) !important;
  --theia-input-foreground: var(--pa-text) !important;
  --theia-input-border: var(--pa-border) !important;
  --theia-input-placeholderForeground: var(--pa-text-subtle) !important;
  --theia-dropdown-background: var(--pa-surface) !important;
  --theia-dropdown-foreground: var(--pa-text) !important;
  --theia-dropdown-border: var(--pa-border) !important;
  --theia-button-background: var(--phaseatlas-brand-600) !important;
  --theia-button-foreground: #ffffff !important;
  --theia-button-hoverBackground: var(--phaseatlas-brand-700) !important;
  --theia-button-border: var(--phaseatlas-brand-600) !important;
  --theia-button-secondaryBackground: var(--pa-surface-soft) !important;
  --theia-button-secondaryForeground: var(--pa-text) !important;
  --theia-button-secondaryHoverBackground: var(--pa-active) !important;
  --theia-menu-background: var(--pa-surface) !important;
  --theia-menu-foreground: var(--pa-text) !important;
  --theia-menu-selectionBackground: var(--pa-active) !important;
  --theia-menu-selectionForeground: var(--pa-active-text) !important;
  --theia-menu-border: var(--pa-border) !important;
  --theia-badge-background: var(--pa-active) !important;
  --theia-badge-foreground: var(--pa-active-text) !important;
  --theia-notifications-background: var(--pa-surface-raised) !important;
  --theia-notifications-foreground: var(--pa-text) !important;
  --theia-notifications-border: var(--pa-border) !important;
  --theia-notificationCenter-border: var(--pa-border) !important;
  --theia-editorWidget-background: var(--pa-surface-raised) !important;
  --theia-editorWidget-border: var(--pa-border) !important;
  --theia-editorSuggestWidget-background: var(--pa-surface-raised) !important;
  --theia-editorSuggestWidget-border: var(--pa-border) !important;
  --theia-scrollbarSlider-background: color-mix(in srgb, var(--pa-text-subtle) 24%, transparent) !important;
  --theia-scrollbarSlider-hoverBackground: color-mix(in srgb, var(--pa-text-subtle) 40%, transparent) !important;
  --theia-scrollbarSlider-activeBackground: color-mix(in srgb, var(--pa-text-subtle) 54%, transparent) !important;
  --theia-terminal-background: var(--pa-surface) !important;
  --theia-terminal-foreground: var(--pa-text) !important;
  background: var(--pa-surface);
}

body,
.theia-ApplicationShell,
.lm-Widget {
  font-family: var(--theia-ui-font-family);
}

input,
select,
textarea,
button,
.theia-button,
.theia-select-component {
  border-radius: var(--phaseatlas-radius-sm) !important;
}

.lm-TabBar.theia-app-sides .lm-TabBar-content {
  gap: 3px;
  padding: 4px;
}

.lm-TabBar.theia-app-sides .lm-TabBar-tab {
  border-radius: var(--phaseatlas-radius-sm);
}

.lm-TabBar.theia-app-left .lm-TabBar-tab.lm-mod-current {
  box-shadow: inset 3px 0 var(--phaseatlas-brand-500);
}

#theia-main-content-panel .lm-TabBar .lm-TabBar-tab.lm-mod-current {
  box-shadow: inset 0 2px var(--phaseatlas-brand-500);
}

.theia-sidepanel-toolbar,
.theia-side-panel .theia-header {
  border-bottom: 1px solid var(--pa-border);
}

.theia-TreeNodeSegmentGrow:hover,
.theia-TreeNodeSegment:hover {
  border-radius: var(--phaseatlas-radius-xs);
}

.theia-notifications-container,
.theia-notification,
.theia-dialog,
.theia-menu {
  border-radius: var(--phaseatlas-radius) !important;
  box-shadow: 0 10px 30px var(--pa-shadow) !important;
}

.phaseatlas-agent-bar {
  display: flex;
  align-items: end;
  gap: 8px;
  margin: 0 0 7px;
  padding: 7px 8px;
  border: 1px solid var(--pa-border);
  border-radius: var(--phaseatlas-radius);
  background: var(--pa-surface-soft);
}

.phaseatlas-agent-identity {
  align-self: center;
  padding: 3px 2px 3px 0;
  color: var(--pa-active-text);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}

.phaseatlas-agent-field {
  display: grid;
  min-width: 0;
  gap: 2px;
  color: var(--pa-text-subtle);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: .04em;
  text-transform: uppercase;
}

.phaseatlas-agent-field:nth-of-type(2) {
  flex: 1 1 130px;
}

.phaseatlas-agent-field select {
  min-width: 78px;
  max-width: 180px;
  height: 25px;
  padding: 0 24px 0 8px;
  border: 1px solid var(--pa-border);
  color: var(--pa-text);
  background: var(--pa-surface);
  font: 500 11px/1 var(--theia-ui-font-family);
  letter-spacing: normal;
  text-transform: none;
}

.phaseatlas-agent-field:nth-of-type(2) select {
  width: 100%;
}

.phaseatlas-task-registry-bar {
  position: fixed;
  z-index: 10000;
  top: 5px;
  right: 88px;
  display: flex;
  height: 34px;
  align-items: center;
  gap: 7px;
  border: 1px solid var(--pa-border);
  border-radius: var(--phaseatlas-radius);
  padding: 3px 4px 3px 5px;
  background: color-mix(in srgb, var(--pa-surface) 96%, transparent);
  box-shadow: 0 8px 24px var(--pa-shadow);
  color: var(--pa-text);
  backdrop-filter: blur(14px);
}

.phaseatlas-task-registry-mark {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border-radius: 6px;
  background: var(--pa-active);
  color: var(--pa-active-text);
  font-size: 8px;
  font-weight: 800;
  letter-spacing: .04em;
}

.phaseatlas-task-registry-copy {
  display: grid;
  min-width: 130px;
  line-height: 1.05;
}

.phaseatlas-task-registry-copy strong {
  font-size: 10px;
  letter-spacing: .06em;
  text-transform: uppercase;
}

.phaseatlas-task-registry-copy small {
  overflow: hidden;
  max-width: 210px;
  color: var(--pa-text-subtle);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.phaseatlas-task-registry-state {
  border-radius: 999px;
  padding: 3px 7px;
  background: color-mix(in srgb, var(--theia-successBackground) 35%, var(--pa-surface-soft));
  color: var(--theia-successForeground);
  font-size: 9px;
  font-weight: 700;
  white-space: nowrap;
}

.phaseatlas-task-registry-state[data-state="draft"] {
  background: color-mix(in srgb, var(--theia-editorWarning-foreground) 18%, var(--pa-surface-soft));
  color: var(--theia-editorWarning-foreground);
}

.phaseatlas-task-registry-bar button {
  height: 26px;
  border: 1px solid var(--pa-border);
  border-radius: 6px;
  padding: 0 8px;
  background: var(--pa-surface-soft);
  color: var(--pa-text-muted);
  font: 650 10px/1 var(--theia-ui-font-family);
}

.phaseatlas-task-registry-bar button:hover:not(:disabled) {
  border-color: var(--phaseatlas-brand-300);
  color: var(--pa-active-text);
}

.phaseatlas-task-registry-bar .phaseatlas-task-registry-publish {
  border-color: var(--phaseatlas-brand-500);
  background: var(--phaseatlas-brand-500);
  color: #fff;
}

.phaseatlas-task-registry-bar button:disabled {
  opacity: .42;
}

@media (max-width: 760px) {
  .phaseatlas-agent-bar {
    flex-wrap: wrap;
  }

  .phaseatlas-agent-identity {
    width: 100%;
  }

  .phaseatlas-task-registry-copy,
  .phaseatlas-task-registry-validate,
  .phaseatlas-task-registry-discard {
    display: none;
  }
}
`;

export function setPhaseAtlasTheiaTheme(theme: PhaseAtlasIdeTheme): void {
  try {
    window.localStorage.setItem("theme", phaseAtlasTheiaThemeId(theme));
    window.localStorage.setItem("theme.background", PHASEATLAS_THEIA_BACKGROUND_COLORS[theme]);
  } catch {
    // Local storage can be unavailable before the loopback origin is ready.
  }
}

export function applyPhaseAtlasTheiaStyle(theme: PhaseAtlasIdeTheme): void {
  const apply = () => {
    document.documentElement.dataset.phaseatlasTheme = theme;
    let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = PHASEATLAS_THEIA_CSS;
      (document.head ?? document.documentElement).append(style);
    }
  };
  if (document.documentElement) apply();
  else window.addEventListener("DOMContentLoaded", apply, { once: true });
}
