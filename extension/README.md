# Forge — an editor-native coding agent on TrueForge

Forge is a VS Code extension whose agent loop runs on [TrueForge](https://github.com/truefoundry/trueforge). It builds a budgeted context pack (BM25 + RepoMap code graph) before the first model call, exposes the editor as MCP tools, stages edits in memory, tests them in a sandboxed copy, and shows every hunk for review before anything touches disk. Model failures fall back automatically inside the same TrueForge session.

**Requirements:** a local TrueForge server (`npx @truefoundry/trueforge@latest`, Node 22 recommended) with at least one model configured. Forge never calls a model provider directly.

- Inline edit: select code, press `⌘⌥K` / `Ctrl+Alt+K`, describe the change.
- Agent mode: open the **Forge** view in the activity bar and describe a change; no file names needed.

Full setup, architecture and the Forge-a-thon write-up: <https://github.com/VirusHacks/forge>.

The RepoMap code graph binary bundled in this build is for macOS on Apple silicon; on other platforms Forge falls back to lexical ranking automatically.
