# Repository editor

PhaseAtlas includes a repository-scoped editor for reviewing agent-generated task bodies and nearby
source files without leaving the desktop app.

## Runtime boundary

The renderer never receives an absolute filesystem capability. It sends a checkout ID and a
repository-relative path to that checkout's utility process. The worker rejects absolute paths and
paths that escape the repository before listing, reading, or saving a file.

The explorer loads directories lazily and omits `.git`, dependency folders, generated output, and
common caches. The text editor rejects binary files and files larger than 5 MB.

## Editor

Monaco Editor provides the same editor foundation as VS Code-based tools. PhaseAtlas enables tabs,
dirty indicators, find, undo/redo, word wrapping, language detection, and Command/Ctrl+S. Closing a
dirty tab or the editor requires confirmation.

Task bodies are normal Markdown files inside `.phaseatlas/`; they remain reviewable in Git and can be
edited by any external tool. Saving a task body invalidates the task projection so its revision and
the workbench update together.
