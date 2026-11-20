# Capture plan and what was actually done

## How the footage was captured

macOS screen recording was not available to the production session: `screencapture` failed with "could not create image from display". The footage was captured another way, from the **real VS Code window**:

- **The window.** A separate VS Code 1.147 instance, the *Extension Development Host*, was launched with its own profile and the Forge extension loaded from `extension/`, using `--remote-debugging-port=9333`.
- **The frames.** `video-production/tools/rec.mjs` and `vscode.mjs` polled `Page.captureScreenshot` over the Chrome DevTools Protocol at 20–24 fps. The renderer viewport was set to 1440×810 CSS px at a 4/3 device scale, so each frame is exactly 1920×1080.
- **Timing.** Each frame's capture timestamp is stored in `frames.tsv`. `tools/tovideo.sh` rebuilds real-time 30 fps video from those timestamps, so a wait looks like a wait.
- **What is visible.** Everything in the frames is VS Code's own rendering: the editor, the diff editor, the Forge webview, the integrated terminal (xterm), and the Simple Browser showing the TrueForge UI.

## What was automated, and what was not

- **Automated: the input.** Keystrokes, typed text, mouse clicks and scrolling were sent by scripts through CDP `Input.*` events (`tools/taskA.mjs`, `tools/taskB.mjs`). They are the same events a person's keyboard and mouse produce, delivered to the same UI.
- **Not automated: everything else.** Every result is real:
  - TrueForge sessions and model calls
  - Forge's context pack, tool calls, staging, auto-verify, fallback and review
  - the per-hunk decisions applied through the extension's own buttons
  - Python, pytest, flask and git output in the integrated terminal
- **No fake mouse pointer.** None was added. Coloured boxes and labels were added in the edit (`composition/compositions/ov*.html`) to point at what is already on screen.
- **Small preparation steps done programmatically, not on camera:**
  - selecting the model in the sidebar's `<select>`, because a native macOS dropdown cannot be clicked over CDP
  - clearing a stale draft from the sidebar textarea
  - clearing notifications before a take

## Environment

| Item | Value |
|---|---|
| Flask | `pallets/flask` 3.1.3 at `22d924701a6ae2e4cd01e9a15bbaf3946094af65`; one worktree per task: `scratch/demo-a`, `demo-b`, `demo-c` |
| Python | One venv per task (`scratch/venv-a/b/c`) with Flask installed editable from that task's worktree. The task's exact verification commands run unmodified |
| TrueForge | 0.185.1, local mode, `http://localhost:8790`. It ran on **Node 22** (`scratch/run-trueforge.sh`): under Node 26 it crashed twice with `undici` `setTypeOfService EINVAL` |
| Models (all free tiers) | Gemini 3.5 Flash Lite / 3.1 Flash Lite / Flash Lite Latest, OpenRouter free, and the test-only `forge-demo-broken/unreachable` |
| Extension settings | `forge.fallbackModels`, `forge.maxModelSwitches: 3`, `forge.maxModelCalls: 80` (raised from 40 after take 2), `forge.pythonPath`. Task C's fallback is a workspace setting in `demo-c/.vscode/settings.json` (git-ignored by Flask) |

## Takes

### Task A

| Take | Model | Result |
|---|---|---|
| 1–2 | `groq/qwen-3-8-27b` | Model returned empty or one-word replacements. Forge's guard rejected two each time; the third reached review and was **rejected** (nothing written) |
| 3 | `groq/gpt-oss-20b` | Correct proposal; side-by-side diff cut off long lines; rejected so the take could be redone in inline diff view |
| 4, 5, 7 | Gemini 3.5 Flash Lite | Driver bug: sidebar clicks were lost while frames were being captured; fixed by pausing capture around clicks |
| 6 | Gemini 3.5 Flash Lite | TrueForge crashed (Node 26); restarted on Node 22 |
| 8 | Gemini 3.5 Flash Lite | Complete, but a stale error toast from the crash covered the terminal; retaken |
| **9 (used)** | Gemini 3.5 Flash Lite | Diff about 2 s after submit; per-hunk untick/re-tick; Accept; `False`; case table; Undo restored the file |

### Task B

| Take | Result |
|---|---|
| 1 | Key 1's 3.5 Flash Lite hit its quota. The fallback, a second Google project via the OpenAI-compatible endpoint, returned 400: Gemini 3 history is not portable there. Only `cli.py` was staged; discarded and the worktree reset |
| 2 | Weak free models kept breaking tests. Auto-verify caught each failure, but the run hit the 40-call cap before the docs. Rejected by the driver's guard (fewer than 3 files) |
| **3 (used)** | 3.5 Flash Lite → 3.1 Flash Lite → Flash Lite Latest → OpenRouter free, all in **one TrueForge session** (`01m7tqmk7v34q3b1fzwp0wzxf6`). 65 model calls, 56 tool calls, 3 min 42 s, $0. 4 hunks in `src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst`. Then: pytest **59 passed**; `flask --help` lists `config`; `flask config` masks the keys; `git status` shows 3 files; Undo restores all of them |

**Two short follow-up captures in the same window, after take 3 (labelled in the edit):**
- `task-b-session`: the TrueForge session page for this run, scrolled from the first turn to `submit_for_review`. During take 3 the Simple Browser had not finished loading.
- `task-b-secret`: the same terminal's scrollback, scrolled up to show `"SECRET_KEY": "***"` from the `flask config` output above. The panel had not maximised during take 3, so that line had scrolled off.

### Task C

| Take | Result |
|---|---|
| **1 (used)** | Fallback setting shown; `curl` → connection refused; Task A instruction; retry in 2 s, then 4 s (network); automatic fallback to Gemini 3.5 Flash Lite in the same session; diff; Reject all; `git status --short` empty; `git diff --exit-code` → "workspace unchanged" |

## v2 edit (developer-perspective narration, slower run)

- **The context pack moment.** It really takes 308 ms, so it cannot be made to "appear slowly" without faking it. Instead the footage is slowed to 0.5× around submit, then **frozen with an on-screen "footage paused to explain" label**. Beside the frozen frame, the four steps are drawn from the run log's `context.pack` event.
- **The run.** Task B's run plays at 5× instead of 14×, still one continuous segment from instruction to review. The tool-call ticker is generated from the run log (`tools/gen_ovB.py`) and aligned to the footage.

## Editing rules that were followed

- **No cut between submitting an instruction and the diff or review appearing.**
  - Task A: real time.
  - Task C: real time.
  - Task B: one continuous segment at 14×, labelled on screen with the real duration.
- **Cuts happen only after a diff appeared or between verification steps:**
  - the blank Simple Browser load during take 3
  - a 2-minute dead wait after `pytest` caused by the driver's output detector
- Every edited second maps back to a recording time in `composition/assets/clips/*.edl.json`.
