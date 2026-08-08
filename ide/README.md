# PhaseAtlas embedded IDE

The desktop app launches an Eclipse Theia backend per checkout or retained run worktree and shows it
in a native view embedded in the PhaseAtlas window. `apps/desktop` owns the launch policy, the view,
and the preload bridge; this directory owns the IDE those point at.

## Source

`ide/theia` is a submodule of [eclipse-theia/theia](https://github.com/eclipse-theia/theia),
pinned to **v1.74.1** — the line the shipped build came from, identified by the
`@theia/ai-registry` package it contains, first published 2026-06-01.

The IDE is built from that source, not from a prebuilt artifact:

```bash
git submodule update --init --depth 1 ide/theia
pnpm build:ide                # npm install + npm build:browser, then copy to ide/lib
pnpm fetch:ide-extensions     # download and verify the pinned extensions
```

Theia 1.74 uses npm workspaces and lerna — it ships `package-lock.json`, not a
yarn lockfile. `build:ide` invokes `npm` directly inside the submodule rather
than joining the pnpm workspace: corepack refuses to run a package manager other
than the one this repository declares, and a partially linked Theia workspace
fails deep inside the build with errors that do not name the cause.

Run it under Node 24 (`nvm use`). A shell whose default is older will fail in
corepack before the script starts. The build is large and slow; neither
`ide/lib` nor `ide/default-extensions` is committed.

`ide/package.json` declares `type: commonjs`. Theia builds CommonJS, and the
repository root declares `type: module`, which would otherwise make Node treat
`ide/lib/**/*.js` as ESM and fail on the first `require()`. The packaged app does
not hit this because `Resources/theia-ide` sits outside any module-typed package.

## What the desktop expects

`apps/desktop/src/main.ts` resolves the backend as:

- packaged: `Resources/theia-ide/lib/backend/main.js`
- development: `ide/lib/backend/main.js`
- override: `PHASEATLAS_THEIA_BACKEND_ENTRY`

and the default plugins as `Resources/theia-default-extensions` or
`ide/default-extensions`.

## Extensions

`default-extensions.manifest.json` pins 14 extensions by version, Open VSX URL
and SHA-256. `fetch:ide-extensions` refuses any download whose digest does not
match, so the plugin set is reproducible rather than whatever Open VSX serves
today.
