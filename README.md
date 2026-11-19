# Forge

**An AI coding agent inside VS Code that reads a large codebase, changes several files for you, tests its own work, and lets you approve every change before anything is saved. The agent runs on [TrueForge](https://github.com/truefoundry/trueforge).**

Built by **Team Husttlers** for the TrueFoundry Forge-a-thon at Techfest, IIT Bombay ([competition brief](task.md)).

---

## The idea in one minute

AI coding tools usually fail in three ways: they read the wrong code, they change things you did not ask for, and they stop working when the AI service has a bad moment. Forge tackles each one:

| Problem | What Forge does |
|---|---|
| *"It looked at the wrong files."* | Before the AI starts, Forge picks the relevant files itself, using text search plus a **code graph** (which function calls which, and which tests cover it). The sidebar shows the chosen files and the reason for each. |
| *"It changed things I didn't ask for."* | Changes are kept **in memory, not on disk**. Forge **runs your tests on a private copy**, then shows every change as a separate piece (a "hunk") that you accept or reject. Applied changes can be **undone** with one click. |
| *"It broke when the AI service failed."* | Forge **waits and retries** on short outages and **switches to a backup model automatically**, inside the same TrueForge session, so no work is lost. |

It is built to work on **free AI models** (Google Gemini, Groq, OpenRouter free tiers), whose strict per-minute limits make every request count.

## What makes it stand out

1. **Graph-guided context.** Forge combines keyword ranking (BM25) with the [RepoMap](https://github.com/SylphxAI/repomap) code graph. The graph is centred on the symbol where both signals agree. Its callers, callees and tests go into the AI's context and are drawn as a small clickable diagram in the sidebar.
2. **The agent checks its own work for free.** After every edit, Forge runs the relevant tests itself (in a sandbox) and tells the agent the result. No extra AI call is spent. Failures that existed before the change are ignored, so the agent never chases a problem it did not cause.
3. **Quality gates.** If tests fail, or the request asked for tests or documentation that are missing, Forge refuses the first "I'm done" and explains what is missing.
4. **A harness that protects against weak models.** Forge fixes small copy mistakes in edits, refuses duplicate insertions, sends incomplete edits back for correction, and tells the agent how many AI calls it has left.
5. **TrueForge used to the full.** Tools are exposed over MCP; TrueForge's tool approval drives the diff review; tools load on demand; long conversations are compacted; and fallback changes the model of the live session. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## How it works

```text
 You (VS Code)                     Forge (the extension)                         TrueForge
 ─────────────                     ─────────────────────                         ─────────
 type a request  ───────────────▶  1. build a context pack      ──────────────▶  runs the agent loop
                                      (BM25 + RepoMap graph)                      and calls the AI model
                                   2. offer tools over MCP       ◀── tool calls ─  (Gemini / Groq / …)
                                      search · read · stage edit · run tests
                                   3. stage edits in memory,
                                      auto-run tests in a sandbox
 review each hunk ◀──────────────  4. "submit for review" needs TrueForge approval
 accept / reject / undo            5. apply accepted hunks, save, keep an undo copy
```

Forge never talks to an AI provider directly; every model call goes through TrueForge.

## Results (live, free models, $0)

| Task (from the brief) | Result |
|---|---|
| **A. Inline edit**: select `get_debug_flag`, type the instruction | Correct 2-hunk edit in **2 AI calls, 1.4 s** (Groq Qwen). Forge automatically rejected the model's first, incomplete answer and the model fixed it. |
| **B. Agent mode**: add `flask config`, with no files named | **3 files** changed (code, test, docs); `pytest tests/test_cli.py` → **59 passed**; `config` appears in `flask --help`; secrets print as `***`; **Undo** restored everything. Survived four Gemini outages through an automatic mid-task model switch. 29 AI calls, 3.8 min. |
| **C. Resilience**: unreachable model endpoint | With a backup model configured: retry, then automatic switch, then a correct edit in 3.9 s. Without one: a clear message. In both cases **no files changed**. |

Automated checks: 19 offline unit tests and 7 tests in a real VS Code instance. Full evidence is in [reports/21-harness-v2.md](reports/21-harness-v2.md).

## Try it

You need Node.js 20+, Git, VS Code and at least one AI model (free tiers work). Python and [`uv`](https://docs.astral.sh/uv/) are only needed for the Flask example.

```bash
# 1. Install and build the extension
git clone https://github.com/dash10107/iit-true-forge.git && cd iit-true-forge
npm ci --prefix extension && npm --prefix extension run compile

# 2. Start TrueForge (leave this terminal open)
OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]' MODEL_HTTP_MAX_RETRIES=0 npx @truefoundry/trueforge@0.185.1
```

3. Open http://localhost:8790 → **Settings → Models** and add a model provider. Example settings: [trueforge/config/model-providers.example.json](trueforge/config/model-providers.example.json). API keys stay inside TrueForge, never in this repository.
4. Open the `extension/` folder in VS Code and press **F5**. A second VS Code window opens with Forge loaded; open any project in it.
5. Optional: copy the settings in [trueforge/config/forge-settings.example.json](trueforge/config/forge-settings.example.json) into your VS Code settings. Use `forge.fallbackModels` to set backup models and `forge.pythonPath` to set the Python used to run your tests.

Forge registers its agent definitions ([trueforge/agents/](trueforge/agents)) in TrueForge automatically on first use.

### Using Forge

- **Inline edit:** select code, press **⌘⌥K** (Ctrl+Alt+K on Windows/Linux), and type what you want. A diff opens; accept or reject each hunk in the Forge sidebar.
- **Agent mode:** click the Forge icon in the activity bar, describe the change, and press ⌘↵. Watch the context card, the code graph and each tool call, then review the hunks. *Open in TrueForge ↗* shows the live session.
- **Stop:** the Stop button, Esc in the sidebar, or ⌘⌥. (Ctrl+Alt+.). Nothing is written before review, so stopping is always safe.
- **Undo:** the *Undo* button after applying, or **Forge: Undo Last Applied Change**.

To reproduce the three competition tasks on Flask 3.1.3, follow [docs/DEMO.md](docs/DEMO.md).

## Repository map

| Path | What is in it |
|---|---|
| [extension/src/core](extension/src/core) | TrueForge client, session runner, model router (retry and fallback), line diff, budget profiles |
| [extension/src/agent](extension/src/agent) | Workspace view, context pack (BM25 + RepoMap graph), staged edits, sandboxed `run_command`, MCP tools, agent run |
| [extension/src/inline](extension/src/inline) | Inline edit (`propose_edit`, approval-gated) |
| [extension/src/review](extension/src/review) | Per-hunk review, apply, undo |
| [extension/src/ui](extension/src/ui), [extension/media](extension/media) | Sidebar (webview) |
| [extension/scripts](extension/scripts) | Unit tests, headless live drivers, agent export |
| [trueforge/](trueforge) | Agent definitions and example configuration |
| [docs/](docs) | Architecture, demo guide, write-up draft |
| [reports/](reports) | Engineering log, from the first audit to the latest results |

## Development

```bash
npm --prefix extension run test:unit     # offline: router, staging, diff, ranking, sandbox, sessions
VSCODE_EXECUTABLE="/Applications/Visual Studio Code.app/Contents/MacOS/Code" npm --prefix extension test   # real editor
node extension/scripts/agent-live.mjs <folder> "<request>" <model>[,<backup>...]   # live agent run, writes nothing
```

## Declarations

- **Team:** Husttlers.
  - Daksh Jain (SPIT) [@dash10107](https://github.com/dash10107)
  - Vinay Vora (DJ Sanghvi, team leader) [@wizardsweb](https://github.com/wizardsweb)
  - Vinisha Bhagwani (SPIT) [@vinisha1014](https://github.com/vinisha1014)
  - Moksh Jain (DJ Sanghvi)
  - Moksha Jain (KJ Somaiya) [@mdevworks](https://github.com/mdevworks)
- **Starting point:** written from scratch; not a fork. The first commit (`d538d12`) is the team's own baseline.
- **Third-party code:**
  - One visually-hidden accessibility CSS rule adapted from [Cline](https://github.com/cline/cline) at `eff43e19b267e171f597ab03733bfed25090f72d` (Apache-2.0).
  - [RepoMap](https://github.com/SylphxAI/repomap) `@sylphx/repomap@1.9.0` (MIT) used unmodified as a dependency.
  - Licences and details are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [third_party/](third_party).
- **Agent loop:** runs on TrueForge 0.185.1 in local mode, through `@truefoundry/trueforge-sdk@0.185.0`. The extension never calls a model provider directly.
- **Models used** (all free tiers, configured in TrueForge, total cost **$0**):
  - Google Gemini: `gemini-3-5-flash-lite`, `gemini-3-1-flash-lite`, `gemini-3-5-flash`, `gemma-4-31b-it`;
  - Groq: `qwen-3-8-27b`;
  - OpenRouter: `openrouter/free`.
  - Any TrueForge model can be selected in the sidebar.
- **AI coding assistants:** Claude Code (Anthropic) and OpenAI Codex were used while building Forge.
- **Secrets:** no API keys are committed. [.env.example](.env.example) and the example configs contain placeholders only.
- **Licence:** [MIT](LICENSE) for the team's code.

## Known limitations

- Free AI tiers often return "busy" (503) or "rate limit" (429) errors. Forge retries and switches models, but a run can still end at the call limit (`forge.maxModelCalls`). Staged changes are then still offered for review.
- Weaker free models make many small tool calls, so agent runs take 20–35 AI calls.
- The command sandbox uses macOS `sandbox-exec`. On Linux, commands run in a throwaway copy without OS-level isolation. Windows is untested.
- The code outline is pattern-based (Python, JS/TS, Go, Rust, Markdown/RST). RepoMap's call graph is static analysis, so its edges are inferences.
