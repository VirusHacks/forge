# Narration script (v3 · final)

Spoken from a developer's point of view. Kokoro-82M `af_heart`, generated locally (`audio/v3/`). "True Forge" and "M C P" are spelled out for pronunciation. Times are positions in `final/TRUEFORGE_FORGEATHON_DEMO.mp4` (v3, 3:54.1).

| Start | End | Line |
|---|---|---|
| 0:00.25 | 0:10.70 | One sentence, no files named. Three files changed, fifty-nine tests passing, a failing model handled on its own, and nothing written until I approved it. This is Forge. |
| 0:11.10 | 0:44.35 | Why build it this way? True Forge runs the agent loop. Our engineering goes into what that loop sees and touches. Graph engineering: Forge maps the repo into a Repo Map code graph of symbols, callers and tests, verifies every edge at its call site, and packs the right neighbourhood into a token budget before the first model call. Then nine M C P tools we built around it: batched search and read, graph lookup, staged edits, sandboxed commands, and an approval-gated submit. Together, that took a three-file task from eighty-five model calls to about twenty-five. |
| 0:44.90 | 0:51.02 | Task A. I select get debug flag, press Command Option K, and describe the change in plain words. |
| 0:52.13 | 1:03.09 | Two seconds later, a real diff opens in the editor. The model had to propose it through an approval-gated tool, so nothing is written yet. I can take each hunk separately, and I accept both. |
| 1:03.73 | 1:05.69 | One edit, saved, and undoable. |
| 1:07.53 | 1:11.14 | Validation: with FLASK DEBUG set to off, it now prints False. |
| 1:14.40 | 1:18.13 | Upper case, mixed case and n are false too, while one and true stay true. |
| 1:18.90 | 1:23.27 | Task B. I ask for a flask config command, without naming a single file. |
| 1:23.40 | 1:43.33 | Before any model call, Forge spends about three hundred milliseconds building a context pack. It takes the key terms from my request, ranks files by matches, then asks the Repo Map code graph who defines FlaskGroup, who calls it, and which tests cover it. It keeps four files, each with a reason, in four point eight of a seven thousand token budget. |
| 1:43.40 | 2:14.86 | Now True Forge runs the loop, five times faster than real time. Every row is a real tool call from the run log. Blue rows are Forge's M C P tools, batched searches and reads, and edits staged in memory, never on disk. Violet rows are True Forge itself, loading tools on demand. When a free model hits its quota, Forge switches models inside the same session. And after each staged edit, Forge tests a sandboxed copy: the model broke four tests, then one, and fixed both before I saw anything. |
| 2:16.62 | 2:20.55 | The review opens on three files: the command, a test, and the docs. |
| 2:22.98 | 2:28.06 | True Forge is now waiting on approval for submit for review. My review is that approval. |
| 2:28.40 | 2:30.45 | I accept, and True Forge records it. |
| 2:33.41 | 2:36.29 | Validation. Fifty-nine C L I tests pass. |
| 2:36.86 | 2:39.23 | Here's a sample app with secrets in its config. |
| 2:41.93 | 2:46.39 | Flask help lists config, and the output masks passwords, tokens and keys, |
| 2:50.04 | 2:53.09 | Scrolling up the same output, the secret key is masked too. |
| 2:56.17 | 3:00.84 | Git shows exactly three changed files, and one click on Undo restores them all. |
| 3:04.40 | 3:10.54 | Here is the True Forge session itself: my request with Forge's context pack, then each turn's tool calls. |
| 3:11.10 | 3:17.67 | Task C. The model endpoint refuses connections, a second model is set as fallback, and I repeat Task A. |
| 3:20.96 | 3:30.24 | Forge's router retries with backoff, two seconds, then four, while I keep scrolling. Then it switches models automatically, in the same session, and the diff arrives. |
| 3:32.06 | 3:36.26 | The fallback's diff is fine, but this test is about safety, so I reject it. |
| 3:39.91 | 3:42.77 | Git confirms the failure changed nothing in the workspace. |
| 3:45.31 | 3:52.97 | That's Forge: True Forge's loop, plus deliberate context, safe edits, real validation, and graceful failure. From team Hustlers. |
