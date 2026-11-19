# Task B checkpoint recovery and readiness

19 November 2026. A real recovery defect was found in the previously recorded Task B run: its third isolated validation succeeded, but after the review-buffer guard stopped application, the sidebar refused all checkpoints with three validation attempts. The saved proposal could not be resumed even though it had passed.

## Recovery change

The sidebar now offers an interrupted checkpoint at the three-attempt boundary when it contains staged hunks and reports a successful last validation. On restore, neither the saved success nor a saved approval is trusted. The exact checkpointed candidate must pass the isolated verifier again; only one such recheck is allowed in that restored session, modified candidates cannot use that exception, and review requires a fresh approval. A checkpoint whose third validation failed still cannot use the exception. No checkpoint restoration applies a patch.

The buffer guard still refuses closed, dirty, version-changed or content-changed documents. The original delayed buffer mismatch was not reproduced, and its exact cause remains unknown; this change makes recovery from that interruption possible without weakening review checks. Recovery may still require a new TrueForge session and model responses to invoke verification and review.

## Real saved proposal: review, save and undo

The actual saved Task B candidate from `reports/evidence/task-b/1795092717177.jsonl.state.json` was loaded into a separate clean linked Flask worktree at the same pinned commit. Its workspace path was changed only in the disposable test copy of the checkpoint. The MCP `verify_patch` re-ran the real isolated verifier, returned the same digest `2be8563b2081ab02`, and rejected `submit_review` before a new approval.

The reusable `extension/scripts/task-b-recovery-host.cjs` then ran inside the actual VS Code extension host. A **scripted test approval**, not a new live model turn or manual UI approval, selected all hunks. The real review flow performed three isolated verifications, displayed the diff tabs, applied and saved the four hunks across `src/flask/cli.py`, `tests/test_cli.py` and `docs/cli.rst`. One VS Code undo restored all three editor buffers; saving them returned the disposable worktree to clean status. The previously user-approved Task B worktree remains separately intact.

This is an integration test of the checkpoint, verifier, review, save and undo path. It is not an end-to-end live TrueForge/sidebar demonstration, and it does not prove the original delayed-buffer problem is fixed. The test launches only when `FORGE_ALLOW_DISPOSABLE_WRITE=1` and requires a clean pinned linked worktree; it modifies and then undoes its test worktree.

## Verification

- Full safety suite: **79 passed, 0 failed**, including the new checkpoint revalidation and approval-boundary regression.
- VS Code extension-host suite: **31 passed, 0 failed**.
- Recovered actual proposal: isolated Flask verification passed; real VS Code review/save/undo integration passed on a disposable worktree.
- Task C's isolated real TrueForge provider-failure test remains documented in [report 19](19-task-c-resilience.md); no new live model calls were made for this recovery work.

To reproduce the host test, after compiling from `extension/`, use a **fresh clean linked worktree** and a saved passing checkpoint:

```sh
FORGE_ALLOW_DISPOSABLE_WRITE=1 \
FORGE_REVIEW_CHECKPOINT=/absolute/path/to/passing-checkpoint.json \
'/Applications/Visual Studio Code.app/Contents/MacOS/Code' /absolute/path/to/disposable-worktree \
  --extensionDevelopmentPath=<repo>/extension \
  --extensionTestsPath=<repo>/extension/scripts/task-b-recovery-host.cjs \
  --user-data-dir=/private/tmp/forge-b-recovery-profile \
  --extensions-dir=/private/tmp/forge-b-recovery-extensions \
  --disable-extensions --skip-welcome --skip-release-notes
```

## Release assessment

The extension remains a competition-oriented prototype, not a production-ready general coding agent. In particular, its Task B context and verifier are pinned to Flask 3.1.3, its verifier uses macOS `sandbox-exec` and a local project venv, the original delayed review-buffer condition has not been reproduced, a full fresh live sidebar review/apply/undo run has not been observed, and no recorded competition demo has been produced. The installed standalone TrueForge instance itself warns that it is not hardened for production/shared access. These are observed scope and verification limits, not assertions that the current tested paths failed.
