---
name: holdback
description: How Holdback checks this app with Kane while you work. Read it when a Holdback brief, a blocked stop or a "Holdback:" line appears.
---

# Working with Holdback

Holdback checks this app against acceptance criteria that Kane, an independent verifier, designed from the spec and that a human approved. You never see Kane's tests; you see what they found.

- After every Edit or Write, Kane checks the app in the background. When it finds a failure, you are woken with a bug report: the criterion, the spec line it comes from, what Kane did, what it saw and its diagnosis. Fix the app so that criterion becomes true, then keep going.
- Make your changes with Edit or Write.
- You cannot finish while a criterion is owed. A refused stop comes with the same bug report; work from it. If Kane is still checking, wait for its verdict.
- Each prompt starts with a `Holdback: N owed (...)` line. `holdback owed` prints the full brief and `holdback status` the table; both only read.
- The spec is the source of truth: read it for intent and detail. If a criterion is ambiguous, choose the most literal reading of the spec. Never write to the spec files, from any tool or shell: they are the human's, and a change Holdback sees after your turn stops the build for the human to review it.
- The verifier's files live outside this repository on purpose. Do not look for them, and never run `kane-cli`: Holdback runs Kane itself.
- Leave git to the human: only read-only git commands (status, diff, log, show) are allowed. Do not change git configuration or hooks.
- The app must start with its configured start command and listen on the port in the `PORT` environment variable.
- If Holdback reports a tamper or a spec change, stop and tell the human. Re-sealing, drift, the spec stage, headless runs and the hook settings are theirs: `holdback reseal`, `drift`, `spec`, `run`, `watch` and `init --agent claude --remove` refuse to run inside Claude Code. Do not try to get around that.
