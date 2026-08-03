<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { FitAddon as FitAddonInstance } from "@xterm/addon-fit";
  import type { Terminal as XTermInstance, ITheme } from "@xterm/xterm";
  import "@xterm/xterm/css/xterm.css";
  import type { TerminalEvent, TerminalSessionSnapshot } from "@phaseatlas/contracts";

  const MAX_CACHED_OUTPUT = 512 * 1024;

  export let checkoutId: string;
  export let repositoryName: string;
  export let theme: "light" | "dark" = "light";
  export let height = 300;
  export let maximized = false;
  export let shortcutLabel = "⌘`";
  export let onClose: () => void;
  export let onHeightChange: (height: number) => void;
  export let onToggleMaximized: () => void;

  let terminalHost: HTMLDivElement;
  let terminal: XTermInstance | null = null;
  let fitAddon: FitAddonInstance | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let sessions: TerminalSessionSnapshot[] = [];
  let activeSessionId = "";
  let loading = true;
  let creating = false;
  let errorMessage = "";
  let disposed = false;
  let resizeTimer = 0;

  $: activeSession = sessions.find((session) => session.sessionId === activeSessionId) ?? null;
  $: if (terminal && theme) applyTerminalTheme();

  onMount(() => {
    let unsubscribe: (() => void) | undefined;
    void initializeTerminal().catch((error) => {
      showError(error);
      loading = false;
    });

    async function initializeTerminal(): Promise<void> {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed) return;
      terminal = new Terminal({
        allowProposedApi: false,
        convertEol: false,
        cursorBlink: true,
        cursorStyle: "bar",
        fontFamily: '"SFMono-Regular", "Cascadia Code", Consolas, monospace',
        fontSize: 12,
        lineHeight: 1.28,
        scrollback: 10_000,
        tabStopWidth: 2,
      });
      fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      applyTerminalTheme();
      terminal.open(terminalHost);
      terminal.onData((data) => {
        if (!activeSessionId || !window.phaseatlas) return;
        void window.phaseatlas.terminals.write(checkoutId, activeSessionId, data).catch(showError);
      });
      resizeObserver = new ResizeObserver(() => scheduleFit());
      resizeObserver.observe(terminalHost);
      unsubscribe = window.phaseatlas?.events.subscribe((desktopEvent) => {
        if (desktopEvent.type !== "terminal.event" || desktopEvent.checkoutId !== checkoutId) return;
        handleTerminalEvent(desktopEvent.event);
      });
      await loadSessions();
    }

    return () => {
      disposed = true;
      window.clearTimeout(resizeTimer);
      unsubscribe?.();
      resizeObserver?.disconnect();
      terminal?.dispose();
      terminal = null;
      fitAddon = null;
    };
  });

  export function focus(): void {
    terminal?.focus();
  }

  async function loadSessions(): Promise<void> {
    if (!window.phaseatlas) return;
    loading = true;
    errorMessage = "";
    try {
      const loaded = await window.phaseatlas.terminals.list(checkoutId);
      if (disposed) return;
      sessions = loaded;
      if (!sessions.length) {
        await createSession();
      } else {
        activeSessionId = sessions.find((session) => session.status === "running")?.sessionId
          ?? sessions.at(-1)?.sessionId
          ?? "";
        await renderActiveSession();
      }
    } catch (error) {
      showError(error);
    } finally {
      loading = false;
    }
  }

  async function createSession(): Promise<void> {
    if (!window.phaseatlas || creating) return;
    creating = true;
    errorMessage = "";
    try {
      await tick();
      fitAddon?.fit();
      const snapshot = await window.phaseatlas.terminals.create(checkoutId, {
        cols: terminal?.cols ?? 100,
        rows: terminal?.rows ?? 24,
      });
      if (disposed) return;
      sessions = [...sessions, snapshot];
      activeSessionId = snapshot.sessionId;
      await renderActiveSession();
    } catch (error) {
      showError(error);
    } finally {
      creating = false;
    }
  }

  async function selectSession(sessionId: string): Promise<void> {
    if (sessionId === activeSessionId) {
      terminal?.focus();
      return;
    }
    activeSessionId = sessionId;
    await renderActiveSession();
  }

  async function closeSession(event: Event, sessionId: string): Promise<void> {
    event.stopPropagation();
    if (!window.phaseatlas) return;
    const currentIndex = sessions.findIndex((session) => session.sessionId === sessionId);
    try {
      await window.phaseatlas.terminals.close(checkoutId, sessionId);
      removeSession(sessionId, currentIndex);
    } catch (error) {
      showError(error);
    }
  }

  function removeSession(sessionId: string, formerIndex = -1): void {
    const wasActive = activeSessionId === sessionId;
    sessions = sessions.filter((session) => session.sessionId !== sessionId);
    if (!wasActive) return;
    const nextIndex = Math.min(Math.max(formerIndex, 0), sessions.length - 1);
    activeSessionId = sessions[nextIndex]?.sessionId ?? "";
    void renderActiveSession();
  }

  async function renderActiveSession(): Promise<void> {
    await tick();
    if (!terminal) return;
    terminal.reset();
    const session = sessions.find((candidate) => candidate.sessionId === activeSessionId);
    if (session?.output) terminal.write(session.output);
    scheduleFit(true);
  }

  function handleTerminalEvent(event: TerminalEvent): void {
    if (event.type === "terminal.output") {
      sessions = sessions.map((session) => {
        if (session.sessionId !== event.sessionId) return session;
        const output = session.output + event.data;
        return {
          ...session,
          output: output.length > MAX_CACHED_OUTPUT ? output.slice(-MAX_CACHED_OUTPUT) : output,
        };
      });
      if (event.sessionId === activeSessionId) terminal?.write(event.data);
      return;
    }
    if (event.type === "terminal.exited") {
      sessions = sessions.map((session) => session.sessionId === event.sessionId
        ? {
            ...session,
            status: "exited",
            exitCode: event.exitCode,
            ...(event.exitSignal !== undefined ? { exitSignal: event.exitSignal } : {}),
          }
        : session);
      return;
    }
    removeSession(event.sessionId, sessions.findIndex((session) => session.sessionId === event.sessionId));
  }

  function scheduleFit(focusAfter = false): void {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (!terminal || !fitAddon || !activeSessionId) return;
      try {
        fitAddon.fit();
        const session = sessions.find((candidate) => candidate.sessionId === activeSessionId);
        if (session?.status === "running") {
          void window.phaseatlas?.terminals.resize(checkoutId, activeSessionId, terminal.cols, terminal.rows).catch(showError);
        }
        if (focusAfter) terminal.focus();
      } catch {
        // The host can briefly have no measurable size while the panel changes repository.
      }
    }, 40);
  }

  function beginResize(event: PointerEvent): void {
    if (maximized) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    const move = (moveEvent: PointerEvent) => {
      const maximum = Math.max(220, window.innerHeight - 116);
      onHeightChange(Math.min(maximum, Math.max(180, startHeight + startY - moveEvent.clientY)));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  function applyTerminalTheme(): void {
    if (!terminal) return;
    const styles = getComputedStyle(document.documentElement);
    const color = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
    const palette: ITheme = {
      background: color("--surface", theme === "dark" ? "#2e3034" : "#ffffff"),
      foreground: color("--text", theme === "dark" ? "#f7f5f5" : "#24262a"),
      cursor: color("--brand-500", "#637ad5"),
      cursorAccent: color("--surface", "#ffffff"),
      selectionBackground: color("--brand-200", "#c3cdf0") + "70",
      black: theme === "dark" ? "#24262a" : "#2e3034",
      red: "#c85b57",
      green: "#2f8a59",
      yellow: "#b8711d",
      blue: color("--brand-500", "#637ad5"),
      magenta: "#8f67b2",
      cyan: "#438a8f",
      white: theme === "dark" ? "#dddcde" : "#efedee",
      brightBlack: "#717373",
      brightRed: "#e77872",
      brightGreen: "#58aa79",
      brightYellow: "#d9a350",
      brightBlue: color("--brand-300", "#9faee4"),
      brightMagenta: "#b48ad2",
      brightCyan: "#68abb0",
      brightWhite: "#f7f5f5",
    };
    terminal.options.theme = palette;
  }

  function showError(error: unknown): void {
    errorMessage = error instanceof Error ? error.message : "The terminal action could not be completed.";
  }
</script>

<section
  class:maximized
  class="terminal-panel"
  style={`height: ${maximized ? "calc(100vh - 52px)" : `${height}px`}`}
  aria-label={`Terminal for ${repositoryName}`}
>
  <button class="resize-handle" type="button" aria-label="Resize terminal panel" onpointerdown={beginResize}></button>
  <header class="terminal-header">
    <div class="terminal-identity">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 7 4.5 5L5 17M12 17h7"/></svg>
      <span><strong>Terminal</strong><small>{repositoryName}</small></span>
    </div>

    <div class="terminal-tabs" role="tablist" aria-label="Terminal sessions">
      {#each sessions as session}
        <div class:active={session.sessionId === activeSessionId} class="terminal-tab-wrap" role="presentation">
          <button
            class="terminal-tab"
            type="button"
            role="tab"
            aria-selected={session.sessionId === activeSessionId}
            tabindex={session.sessionId === activeSessionId ? 0 : -1}
            onclick={() => selectSession(session.sessionId)}
          >
            <span class:exited={session.status === "exited"} class="session-state"></span>
            <span>{session.title}</span>
            {#if session.status === "exited"}<small>{session.exitCode ?? "done"}</small>{/if}
          </button>
          <button class="tab-close" type="button" aria-label={`Close ${session.title}`} onclick={(event) => closeSession(event, session.sessionId)}>×</button>
        </div>
      {/each}
    </div>

    <div class="terminal-actions">
      <button type="button" aria-label="New terminal" title="New terminal" onclick={createSession} disabled={creating}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      </button>
      <button type="button" aria-label={maximized ? "Restore terminal" : "Maximize terminal"} title={maximized ? "Restore terminal" : "Maximize terminal"} onclick={onToggleMaximized}>
        <svg viewBox="0 0 24 24" aria-hidden="true">{#if maximized}<path d="M8 8h11v11H8zM5 16V5h11"/>{:else}<path d="M5 9V5h4M15 5h4v4M19 15v4h-4M9 19H5v-4"/>{/if}</svg>
      </button>
      <button type="button" aria-label="Close terminal panel" title={`Close terminal (${shortcutLabel})`} onclick={onClose}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>
      </button>
    </div>
  </header>

  <div class="terminal-body">
    <div bind:this={terminalHost} class:hidden={!activeSessionId} class="terminal-host"></div>
    {#if loading}
      <div class="terminal-overlay"><span class="spinner"></span><strong>Starting repository terminal…</strong></div>
    {:else if !sessions.length}
      <div class="terminal-overlay">
        <strong>No terminal sessions</strong>
        <p>Start a shell rooted at this repository.</p>
        <button type="button" onclick={createSession} disabled={creating}>{creating ? "Starting…" : "New terminal"}</button>
      </div>
    {/if}
    {#if errorMessage}
      <div class="terminal-error" role="alert"><span>!</span><p>{errorMessage}</p><button type="button" aria-label="Dismiss terminal error" onclick={() => errorMessage = ""}>×</button></div>
    {/if}
  </div>

  <footer class="terminal-statusbar">
    <span><i data-status={activeSession?.status ?? "idle"}></i>{activeSession?.shell ?? "shell"}</span>
    <code title={activeSession?.cwd}>{activeSession?.cwd ?? repositoryName}</code>
    <span class="terminal-shortcut">Toggle <kbd>{shortcutLabel}</kbd></span>
  </footer>
</section>

<style>
  .terminal-panel { position: fixed; z-index: 90; right: 0; bottom: 0; left: var(--sidebar-width); display: grid; min-height: 180px; grid-template-rows: 40px minmax(0,1fr) 24px; overflow: hidden; border-top: 1px solid var(--border); background: var(--surface); color: var(--text); box-shadow: 0 -10px 30px rgba(24,24,27,.08); }
  .terminal-panel.maximized { z-index: 91; }
  .resize-handle { position: absolute; z-index: 3; top: -3px; right: 0; left: 0; height: 7px; border: 0; padding: 0; background: transparent; cursor: ns-resize; }
  .resize-handle:hover,.resize-handle:focus-visible { background: var(--brand-500); }
  .maximized .resize-handle { display: none; }
  .terminal-header { display: flex; min-width: 0; align-items: stretch; border-bottom: 1px solid var(--border); background: var(--surface-soft); }
  .terminal-identity { display: flex; width: 148px; flex: 0 0 148px; align-items: center; gap: 8px; border-right: 1px solid var(--border); padding: 0 12px; }
  .terminal-identity svg,.terminal-actions svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.8; }
  .terminal-identity > svg { color: var(--active-text); }
  .terminal-identity strong,.terminal-identity small { display: block; line-height: 1.15; }
  .terminal-identity strong { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; }
  .terminal-identity small { max-width: 94px; overflow: hidden; margin-top: 2px; color: var(--text-subtle); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
  .terminal-tabs { display: flex; min-width: 0; flex: 1; overflow-x: auto; scrollbar-width: none; }
  .terminal-tabs::-webkit-scrollbar { display: none; }
  .terminal-tab-wrap { position: relative; display: grid; min-width: 116px; max-width: 190px; grid-template-columns: minmax(0,1fr) 27px; border-right: 1px solid var(--border); }
  .terminal-tab-wrap::after { position: absolute; right: 0; bottom: 0; left: 0; height: 2px; background: transparent; content: ""; pointer-events: none; }
  .terminal-tab-wrap:hover,.terminal-tab-wrap.active { background: var(--surface); color: var(--text); }
  .terminal-tab-wrap.active::after { background: var(--brand-500); }
  .terminal-tab { display: flex; min-width: 0; align-items: center; gap: 7px; border: 0; padding: 0 0 0 9px; background: transparent; color: var(--text-muted); font-size: 10px; }
  .terminal-tab:hover,.terminal-tab-wrap.active .terminal-tab { color: var(--text); }
  .terminal-tab > span:nth-child(2) { min-width: 0; flex: 1; overflow: hidden; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .terminal-tab small { color: var(--text-subtle); font: 9px/1 "SFMono-Regular",Consolas,monospace; }
  .session-state { width: 6px; height: 6px; flex: 0 0 6px; border-radius: 50%; background: var(--success-500); }
  .session-state.exited { background: var(--text-subtle); }
  .tab-close { display: grid; width: 20px; height: 20px; align-self: center; place-items: center; border: 0; border-radius: var(--radius-xs); background: transparent; color: var(--text-subtle); font-size: 14px; line-height: 1; opacity: 0; }
  .terminal-tab-wrap:hover .tab-close,.terminal-tab-wrap.active .tab-close,.tab-close:focus-visible { opacity: 1; }
  .tab-close:hover { background: var(--surface-soft); color: var(--text); }
  .terminal-actions { display: flex; flex: 0 0 auto; align-items: center; border-left: 1px solid var(--border); padding: 0 6px; }
  .terminal-actions button { display: grid; width: 30px; height: 30px; place-items: center; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--text-muted); }
  .terminal-actions button:hover { background: var(--active-surface); color: var(--active-text); }
  .terminal-body { position: relative; min-height: 0; overflow: hidden; background: var(--surface); }
  .terminal-host { position: absolute; inset: 0; padding: 8px 10px 4px; }
  .terminal-host.hidden { visibility: hidden; }
  .terminal-overlay { position: absolute; inset: 0; display: grid; place-content: center; justify-items: center; color: var(--text-muted); text-align: center; }
  .terminal-overlay strong { color: var(--text); font-size: 12px; }
  .terminal-overlay p { margin: 4px 0 12px; color: var(--text-subtle); font-size: 11px; }
  .terminal-overlay button { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px 10px; background: var(--surface-soft); color: var(--text); font-size: 11px; }
  .spinner { width: 18px; height: 18px; margin-bottom: 9px; border: 2px solid var(--border); border-top-color: var(--brand-500); border-radius: 50%; animation: spin .8s linear infinite; }
  .terminal-error { position: absolute; z-index: 2; right: 12px; bottom: 10px; display: grid; max-width: min(520px,calc(100% - 24px)); grid-template-columns: 20px minmax(0,1fr) 24px; align-items: center; gap: 7px; border: 1px solid var(--warning-500); border-radius: var(--radius); padding: 7px 8px; background: var(--warning-surface); color: var(--warning-text); box-shadow: var(--shadow-hover); }
  .terminal-error > span { display: grid; width: 20px; height: 20px; place-items: center; border-radius: var(--radius-xs); background: var(--warning-500); color: #fff; font-size: 10px; font-weight: 800; }
  .terminal-error p { overflow: hidden; margin: 0; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
  .terminal-error button { border: 0; background: transparent; color: inherit; font-size: 16px; }
  .terminal-statusbar { display: flex; min-width: 0; align-items: center; gap: 9px; border-top: 1px solid var(--border); padding: 0 10px; background: var(--surface-soft); color: var(--text-subtle); font-size: 9px; }
  .terminal-statusbar > span { display: flex; align-items: center; gap: 5px; }
  .terminal-statusbar i { width: 6px; height: 6px; border-radius: 50%; background: var(--text-subtle); }
  .terminal-statusbar i[data-status="running"] { background: var(--success-500); }
  .terminal-statusbar code { min-width: 0; flex: 1; overflow: hidden; border: 0; padding: 0; background: transparent; color: var(--text-subtle); font: 9px/1.2 "SFMono-Regular",Consolas,monospace; text-overflow: ellipsis; white-space: nowrap; }
  .terminal-shortcut { flex: 0 0 auto; }
  .terminal-shortcut kbd { min-width: 25px; border: 1px solid var(--border); border-bottom-width: 2px; border-radius: var(--radius-xs); padding: 1px 4px; background: var(--surface); color: var(--text-muted); font: 9px/1.2 "SFMono-Regular",Consolas,monospace; text-align: center; }
  :global(.terminal-host .xterm) { height: 100%; }
  :global(.terminal-host .xterm-viewport) { scrollbar-color: var(--border) transparent; scrollbar-width: thin; }
  :global(.terminal-host .xterm-screen) { font-variant-ligatures: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (max-width: 767.98px) { .terminal-panel { left: 0; }.terminal-identity { width: 112px; flex-basis: 112px; }.terminal-identity small { max-width: 62px; }.terminal-statusbar code { display: none; }.terminal-shortcut { margin-left: auto; } }
  @media (max-width: 520px) { .terminal-identity { width: 42px; flex-basis: 42px; justify-content: center; padding: 0; }.terminal-identity > span { display: none; }.terminal-tab-wrap { min-width: 108px; }.terminal-actions button:nth-child(2) { display: none; }.terminal-shortcut { display: none !important; } }
</style>
