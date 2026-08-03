import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import type {
  TerminalCreateInput,
  TerminalEvent,
  TerminalSessionSnapshot,
} from "@phaseatlas/contracts";
import { spawn, type IDisposable, type IPty, type IPtyForkOptions } from "node-pty";

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 24;
const MAX_DIMENSION = 1_000;
const MAX_INPUT_LENGTH = 64 * 1024;
const MAX_OUTPUT_LENGTH = 512 * 1024;
const MAX_SESSIONS = 12;

export type TerminalSpawner = (file: string, args: string[], options: IPtyForkOptions) => IPty;

interface ManagedTerminal {
  process: IPty;
  snapshot: TerminalSessionSnapshot;
  dataDisposable: IDisposable;
  exitDisposable: IDisposable;
}

function integerInRange(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > MAX_DIMENSION) {
    throw new Error(`Terminal dimensions must be integers between 1 and ${MAX_DIMENSION}.`);
  }
  return Number(value);
}

function terminalShell(): string {
  if (process.platform === "win32") return process.env.COMSPEC || "powershell.exe";
  return process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
}

function terminalEnvironment(repositoryRoot: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") environment[key] = value;
  }
  environment.TERM = "xterm-256color";
  environment.COLORTERM = "truecolor";
  environment.TERM_PROGRAM = "PhaseAtlas";
  environment.PWD = repositoryRoot;
  return environment;
}

function copySnapshot(snapshot: TerminalSessionSnapshot): TerminalSessionSnapshot {
  return { ...snapshot };
}

export class TerminalSessionManager {
  private readonly sessions = new Map<string, ManagedTerminal>();
  private sequence = 0;

  constructor(
    private readonly repositoryRoot: string,
    private readonly emit: (event: TerminalEvent) => void,
    private readonly spawnTerminal: TerminalSpawner = spawn,
  ) {}

  list(): TerminalSessionSnapshot[] {
    return [...this.sessions.values()]
      .map(({ snapshot }) => copySnapshot(snapshot))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  create(input: Partial<TerminalCreateInput> = {}): TerminalSessionSnapshot {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`A repository can have at most ${MAX_SESSIONS} terminal sessions.`);
    }
    const cols = integerInRange(input.cols, DEFAULT_COLS);
    const rows = integerInRange(input.rows, DEFAULT_ROWS);
    const shell = terminalShell();
    const processHandle = this.spawnTerminal(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: this.repositoryRoot,
      env: terminalEnvironment(this.repositoryRoot),
    });
    const sessionId = randomUUID();
    const sessionNumber = ++this.sequence;
    const snapshot: TerminalSessionSnapshot = {
      sessionId,
      title: `Terminal ${sessionNumber}`,
      shell: path.basename(shell),
      cwd: this.repositoryRoot,
      status: "running",
      cols,
      rows,
      output: "",
      createdAt: new Date().toISOString(),
    };
    const managed = {
      process: processHandle,
      snapshot,
      dataDisposable: processHandle.onData((data) => this.onData(sessionId, data)),
      exitDisposable: processHandle.onExit((event) => this.onExit(sessionId, event.exitCode, event.signal)),
    } satisfies ManagedTerminal;
    this.sessions.set(sessionId, managed);
    return copySnapshot(snapshot);
  }

  write(sessionId: string, data: string): void {
    const session = this.requireSession(sessionId);
    if (session.snapshot.status !== "running") throw new Error("The terminal process has already exited.");
    if (!data) return;
    if (data.length > MAX_INPUT_LENGTH) throw new Error("Terminal input is too large.");
    session.process.write(data);
  }

  resize(sessionId: string, cols: unknown, rows: unknown): void {
    const session = this.requireSession(sessionId);
    const nextCols = integerInRange(cols, session.snapshot.cols);
    const nextRows = integerInRange(rows, session.snapshot.rows);
    session.snapshot.cols = nextCols;
    session.snapshot.rows = nextRows;
    if (session.snapshot.status === "running") session.process.resize(nextCols, nextRows);
  }

  close(sessionId: string): void {
    const session = this.requireSession(sessionId);
    this.sessions.delete(sessionId);
    session.dataDisposable.dispose();
    session.exitDisposable.dispose();
    if (session.snapshot.status === "running") session.process.kill();
    this.emit({
      type: "terminal.closed",
      sessionId,
      timestamp: new Date().toISOString(),
    });
  }

  dispose(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      const session = this.sessions.get(sessionId);
      if (!session) continue;
      this.sessions.delete(sessionId);
      session.dataDisposable.dispose();
      session.exitDisposable.dispose();
      if (session.snapshot.status === "running") session.process.kill();
    }
  }

  private requireSession(sessionId: string): ManagedTerminal {
    if (!sessionId) throw new Error("sessionId is required.");
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Terminal session was not found.");
    return session;
  }

  private onData(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || !data) return;
    const nextOutput = session.snapshot.output + data;
    session.snapshot.output = nextOutput.length > MAX_OUTPUT_LENGTH
      ? nextOutput.slice(nextOutput.length - MAX_OUTPUT_LENGTH)
      : nextOutput;
    this.emit({
      type: "terminal.output",
      sessionId,
      data,
      timestamp: new Date().toISOString(),
    });
  }

  private onExit(sessionId: string, exitCode: number, exitSignal?: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.snapshot.status = "exited";
    session.snapshot.exitCode = exitCode;
    if (exitSignal !== undefined) session.snapshot.exitSignal = exitSignal;
    this.emit({
      type: "terminal.exited",
      sessionId,
      exitCode,
      ...(exitSignal !== undefined ? { exitSignal } : {}),
      timestamp: new Date().toISOString(),
    });
  }
}
