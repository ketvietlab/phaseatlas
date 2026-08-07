# PhaseAtlas embedded IDE

The desktop app launches an Eclipse Theia backend per checkout and shows it in its
own window. `apps/desktop` owns the launch policy, the window and the preload
bridge; this directory owns the IDE build those point at.

`apps/desktop/src/main.ts` resolves the backend as:

- packaged: `Resources/theia-ide/lib/backend/main.js`
- development: `ide/lib/backend/main.js`
- override: `PHASEATLAS_THEIA_BACKEND_ENTRY`

and the default plugins as `Resources/theia-default-extensions` or
`ide/default-extensions`.

## Status

`default-extensions.manifest.json` is the recovered pin list: 14 extensions with
their exact versions, Open VSX URLs and SHA-256 digests. It is the input a fetch
step needs, and it is verifiable — a download that does not match its digest must
be rejected.

The Theia application package itself is **not yet in this repository**. The build
that ships in the installed app contains only `lib/`, with no manifest naming the
`@theia/*` versions it was built from, so the dependency set cannot be recovered
from the artifact. Pinning it needs the versions chosen deliberately rather than
guessed.
