# Repository terminal contract

## Checkout ownership

Every terminal session belongs to exactly one repository utility process. The worker resolves the
working directory from its canonical checkout root at startup; the renderer cannot provide a path,
shell executable, command, environment, or process identifier. Switching repositories changes the
checkout ID used by the typed preload API and therefore selects a different worker-owned session set.

Terminal sessions remain alive while their repository is not selected. A worker with retained terminal
sessions is not eligible for idle shutdown. Closing a terminal is explicit and terminates only that
session; closing the application terminates all worker-owned sessions.

## Bounded desktop API

The renderer can perform only five operations: list sessions, create a session with bounded rows and
columns, write bounded terminal input, resize an existing session, and close an existing session.
The worker validates every request and caps each repository at twelve sessions. Terminal scrollback
snapshots are capped at 512 KiB per session and input messages are capped at 64 KiB.

Output, exit, and close notifications cross the worker boundary as typed `terminal.event` messages.
The renderer may display these events but cannot use them to change canonical repository, workspace,
task, policy, or evidence state.

## Renderer isolation

The Svelte renderer uses xterm only for presentation and keyboard input. It has no Node.js, Electron,
PTY, filesystem, or process imports. Native PTY creation and lifecycle management stay inside the
checkout-bound repository worker, while Electron main and preload only route typed identifiers and
bounded values.
