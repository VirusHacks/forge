# TrueForge Task A research handoff

**Result on 19 November 2026 (India time).** The agent generated the requested Flask change, VS Code displayed it before writing, the user approved it, and the official verifier passed. The pristine Flask fixture was clean at the final check. The experiment used TrueForge 0.185.1, its TypeScript SDK 0.185.0, and the configured Groq model `groq/qwen-3-8-27b`.

## Task and result

The extension captured the complete six-line `get_debug_flag` selection in `src/flask/helpers.py` and sent the following request through a saved TrueForge agent.

> Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.

The approved hunk added `"off"` and `"n"` to the existing comparison. The generated docstring describes unset and empty inputs, lists `0`, `false`, `no`, `off`, and `n` with case-insensitive matching, and explains other nonempty inputs. Only the disposable worktree's helper changed (six insertions, one deletion). Its HEAD remains `22d924701a6ae2e4cd01e9a15bbaf3946094af65`.

## Winning run

| Evidence | Observed value |
|---|---|
| Saved agent | `forge-task-a-1bff3d9c` |
| Session | `01m7qzrerdcxc875hr81jmkay1` |
| Turn | `01m7qzrerhj2yzc17g74551y5d` |
| Model calls | 2 completed responses |
| Tokens | 2,131 input and 424 output (2,555 total) |
| Workspace tools | 1 × `search_repository`, 1 × `read_file` |
| Other streamed events | 1 turn created, 1 MCP initialization, 342 message deltas, 2 tool responses, 1 terminal event |
| SDK retries and stream reconnects | 0 |
| Outcome | Real VS Code diff opened with a clean source buffer. Approved bytes matched the saved turn. |

TrueForge handled agent execution, the session, model traffic, and the streamed turn. The extension served read-only MCP tools on loopback, validated the returned JSON against the selected source, and rendered the replacement in a read-only virtual document. It applies one reviewed range after checking the source version, buffer, and disk contents. The CLI rehearsal shares the agent definition, request builder, MCP implementation and patch validator with the extension.

Approval came through chat after the extension host confirmed the diff was open. A separate VS Code host retrieved the same saved turn, checked it against the rendered preview and clean baseline, reconstructed the pending review, and invoked the extension's production approval handler. It checked the saved file against the proposal. This exercised the handler and the save, without a physical click on the original notification.

## Development runs, including failures

Counts below come from the local TrueForge session and turn records. A completed model message has a persisted response. Each of the eight error turns also reported a rejected provider request. Unreported tokens on rejected requests are not an independent billing measurement.

| Run | Model | Completed model responses | Reported input / output | Tool requests recorded | Outcome |
|---|---|---:|---:|---|---|
| 1 | GPT-OSS 20B | 1 | 1,944 / 152 | `call_tool` | Next request failed with HTTP 400, unsupported assistant `reasoning_content` |
| 2 | GPT-OSS 20B | 1 | 1,944 / 183 | `call_tool` | Same HTTP 400 |
| 3 | Llama 3.3 70B | 0 | 0 / 0 | None | HTTP 404, model missing or inaccessible |
| 4 | Qwen | 0 | 0 / 0 | None executed | Provider rejected unlisted `call_work_profile` |
| 5 | Qwen | 0 | 0 / 0 | None executed | Provider rejected unlisted `search_replace` |
| 6 | Qwen | 0 | 0 / 0 | None | HTTP 400, JSON mode incompatible with tool calling |
| 7 | Qwen | 2 | 2,211 / 60 | Search and read | HTTP 413 on next request, 7,003 input tokens requested against a 7,000 limit |
| 8 | Qwen | 2 | 1,930 / 89 | 3 reads | Two missing paths, then a full helper file. Next request hit HTTP 429 |
| 9 | Qwen | 2 | 2,071 / 377 | Search and read | CLI proposal validated. Docstring omitted the empty string |
| 10 | Qwen | 2 | 2,115 / 411 | Search and read | Real editor diff. Same documentation omission |
| **11** | **Qwen** | **2** | **2,131 / 424** | **Search and read** | **Approved and passed** |

Across 11 deliberate turns, TrueForge recorded **12 completed model responses and eight terminal provider failures**, with **14,346 input and 1,696 output tokens**. SDK retries were disabled. The runs after the first were separate sessions. The two GPT-OSS discovery calls did not reach the extension's workspace tools. The saved requests across the remaining turns show seven file reads and four searches. Provider-side internal retries are not exposed.

The original reader returned all 23,517 bytes of the Flask helper module. The revised request supplies the exact selected lines and tool arguments, the reader returns bounded excerpts, and search output is capped. The final three runs each finished with one search, one read and two model responses. Adding unset and empty inputs to the documentation review instruction addressed the omission without embedding the implementation.

## Verification

| Check | Actual result |
|---|---|
| TypeScript build | Passed |
| Patch and MCP safety tests | 5/5 passed, including overbroad original snippets, literal replacement text, bounded line reads and a symlink to a restricted file |
| Installed VS Code extension-host suite | 7/7 passed, exit 0, including rejection, cancellation during review and a stale file before approval |
| Verification import | Resolved to `scratch/flask-task-a-agent/src/flask/__init__.py` |
| Official behavior checks | `FLASK_DEBUG=off`, `OFF`, `n`, `N` each returned `False` |
| Official Flask CLI suite | 58 passed in 0.12 s |
| Combined helper and CLI suite | 93 passed in 0.21 s, including the CLI tests |
| Worktree checks | Only `src/flask/helpers.py` changed. `git diff --check` passed. Pristine fixture clean. |

Review cancellation and stale-file refusal were exercised locally. Cancellation of an in-flight remote generation, provider failover, and recovery from an interrupted stream were not exercised by this run. This result covers Task A.

## Repeat the checks

Run `scripts/verify-task-a.sh` from the project root to verify the approved worktree again. For a fresh model rehearsal, point `FLASK_TASK_A_REPO` at a fresh, clean disposable worktree of the pinned commit. Set `TRUEFORGE_MODEL` to a model listed in the local TrueForge instance. Run `npm --prefix extension run task-a:live` for the CLI proposal or run `npm --prefix extension run task-a:review` with `VSCODE_EXECUTABLE` set to the installed VS Code executable to open the real diff. The normal editor entry point is **Forge: Task A — Propose Selected Function Patch**.
