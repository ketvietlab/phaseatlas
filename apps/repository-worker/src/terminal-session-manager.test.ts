import assert from "node:assert/strict";
import test from "node:test";
import type { TerminalEvent } from "@phaseatlas/contracts";
import type { IDisposable, IPty, IPtyForkOptions } from "node-pty";
import { TerminalSessionManager } from "./terminal-session-manager.js";

class FakePty {
  dataListener: ((data: string) => void) | null = null;
  exitListener: ((event: { exitCode: number; signal?: number }) => void) | null = null;
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  killed = false;

  onData(listener: (data: string) => void): IDisposable {
    this.dataListener = listener;
    return { dispose: () => { this.dataListener = null; } };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): IDisposable {
    this.exitListener = listener;
    return { dispose: () => { this.exitListener = null; } };
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  kill(): void {
    this.killed = true;
  }
}

test("binds every terminal session to the worker repository root", () => {
  const events: TerminalEvent[] = [];
  const capture: { pty?: FakePty; options?: IPtyForkOptions } = {};
  const manager = new TerminalSessionManager(
    "/repositories/phaseatlas",
    (event) => events.push(event),
    (_file, _args, options) => {
      capture.options = options;
      capture.pty = new FakePty();
      return capture.pty as unknown as IPty;
    },
  );

  const session = manager.create({ cols: 120, rows: 32 });
  assert.ok(capture.options);
  assert.ok(capture.pty);
  assert.equal(capture.options.cwd, "/repositories/phaseatlas");
  assert.equal(capture.options.env?.PWD, "/repositories/phaseatlas");
  assert.equal(session.cwd, "/repositories/phaseatlas");
  assert.equal(session.status, "running");

  capture.pty.dataListener?.("ready\r\n");
  assert.equal(manager.list()[0]?.output, "ready\r\n");
  assert.equal(events[0]?.type, "terminal.output");

  manager.write(session.sessionId, "pwd\r");
  manager.resize(session.sessionId, 90, 24);
  assert.deepEqual(capture.pty.writes, ["pwd\r"]);
  assert.deepEqual(capture.pty.resizes, [[90, 24]]);

  capture.pty.exitListener?.({ exitCode: 0 });
  assert.equal(manager.list()[0]?.status, "exited");
  assert.throws(() => manager.write(session.sessionId, "echo after exit\r"), /already exited/);

  manager.close(session.sessionId);
  assert.deepEqual(manager.list(), []);
  assert.equal(events.at(-1)?.type, "terminal.closed");
});

test("rejects invalid terminal dimensions before spawning a process", () => {
  let spawned = false;
  const manager = new TerminalSessionManager("/repositories/phaseatlas", () => undefined, () => {
    spawned = true;
    return new FakePty() as unknown as IPty;
  });

  assert.throws(() => manager.create({ cols: 0, rows: 24 }), /dimensions/);
  assert.throws(() => manager.create({ cols: 80, rows: 1_001 }), /dimensions/);
  assert.equal(spawned, false);
});
