# Claims

Every public statement about Holdback, with the file or script behind it. Four tags:

- **REPRODUCIBLE**: anyone can check it without credentials, with `pnpm -r test` or a file in this repo.
- **VERIFIED-LIVE**: it happened in a real run, with the real Kane CLI, Claude Code and the Venice API, and a recorded ledger or live capture in this repo shows it.
- **MODELED**: derived or rendered from recorded data; not observed as such.
- **NOT-CLAIMED**: what Holdback does not do, or has not shown yet.

## The first live run

All but the last row come from `apps/dashboard/fixtures/ledger.jsonl`: the first live run's ledger, sanitized (Kane CLI 0.10.4, Claude Code on `sonnet`, breaker `deepseek-v4-flash`; config in `apps/dashboard/fixtures/config.json`). `holdback status` or the dashboard replay reduces it.

| Claim | Tag | Evidence |
| --- | --- | --- |
| Kane asked 2 clarifying questions about a 4-rule spec before designing. | VERIFIED-LIVE | `spec.paused` (2 questions), `spec.answered`; the spec's rules are quoted in [JUDGES.md](JUDGES.md#3-the-recorded-ledger-and-screenshots) |
| Kane designed 11 acceptance criteria, each citing the spec line it comes from, and 3 tests. | VERIFIED-LIVE | `design`: 11 `acs` with `cites`, 3 `tests`, 22.55 credits |
| The criteria and tests were sealed before the agent's first turn. | VERIFIED-LIVE | `seal` (3 test files, Kane's variables, `holdback.config.json`, `PRD.md`) at 11:42:34, then `turn.start` 1 at 11:47:22 |
| Claude Code built the app from the owed brief in one 72-second turn. | VERIFIED-LIVE | `turn.start` 1 (11 owed); `turn.end` 1: `agentExit` 0, `durationMs` 71732, one commit |
| 2 of the 3 tests passed on the first check. | VERIFIED-LIVE | turn-1 `run` events: t-1 and t-2 `passed` |
| The third test timed out while authoring its 11 steps, after 9 had passed. | VERIFIED-LIVE | turn-1 `run` t-3: `error`, `timeout`, 9 steps; the sealed t-3 (sha256 `5eb3fb75…` in `seal`) is byte-identical to `packages/core/test/fixtures/kane/tests/inclusive-limits-and-published-household-size-schedule_test.md`, which has 11 steps |
| A breaker on a different model planted 2 bugs: `income <= limit` became `income >= limit`, and `snap \|\|` was dropped. | VERIFIED-LIVE | `mutant` m-ac-2-1 and m-ac-3-1: `patch`, `model` |
| Kane caught both on replay, with healing off, and gave its own diagnosis. ac-2 and ac-3 became proved. | VERIFIED-LIVE | `run` with `kind` falsify: `failed` at step 2, `verdict` with `bugTitle`, `rootCause`, `observed`; `mutant.verdict` killed; [JUDGES.md](JUDGES.md#5-a-planted-bug-kane-caught) step 5 |
| The breaker cost $0.0008 for both bugs. | VERIFIED-LIVE | `mutant.usd`: 0.000345 + 0.00045 |
| A passing test replayed for 0 credits; a replay Kane healed cost 17.58. | VERIFIED-LIVE | turn-2 `run` t-2 (`credits` 0), t-1 (`healTriggered`, `credits` 17.58) |
| The gate stayed shut: 5 criteria were still owed when the run was stopped by hand in turn 2. | VERIFIED-LIVE | reducing the ledger: ac-1, ac-4 to ac-7 owed; turn 2 has no `turn.end` |
| Kane changed nothing Holdback seals: no seal check during the run found a change. | VERIFIED-LIVE | a `recordings` snapshot after every Kane batch, no `tamper` event |
| Kane's verdicts tell an app failure from an environment or automation failure. | VERIFIED-LIVE | `verdict.family` in `packages/core/test/fixtures/kane/11-heal-replay-t1.ndjson` (automation_bug) and `12-env-failure-t3.ndjson` (environment_issue), both captured in this run |

## What the code does

Each row is covered by unit tests that run with fake Kane and Claude Code binaries ([MOCKS.md](MOCKS.md)).

| Claim | Tag | Evidence |
| --- | --- | --- |
| The agent never reads a test file. Its brief carries the criterion, the spec line, the text of the step that failed, what Kane saw, its diagnosis and a screenshot. | REPRODUCIBLE | `packages/core/src/loop/brief.ts`; `packages/core/test/brief.test.ts` |
| The gate opens only when nothing is owed or regressed, no tamper is on record, and no test's latest run proved nothing. | REPRODUCIBLE | `packages/core/src/ledger/gate.ts`; `packages/core/test/ledger.test.ts` |
| The tests live outside the repo. Deny rules and a guard hook on every tool call keep the agent out, and a guard that crashes denies. | REPRODUCIBLE | `packages/core/src/agent/guard.ts`, `guard-main.ts`; `packages/core/test/guard.test.ts`, `guard-main.test.ts` |
| A changed test, config, Kane recording, ledger, or `.git/config` key that makes git run code is a tamper. The gate stays shut until a human re-seals. | REPRODUCIBLE | `packages/core/src/seal.ts`, `tamper.ts`; `packages/core/test/tamper.test.ts`, `build.test.ts` |
| A change to the spec alone is drift, not a tamper: the run stops (exit 3) for `holdback drift`, Kane's results so far stand, and the agent's turn is committed without the spec. Next to any other sealed change it is a tamper. | REPRODUCIBLE | `packages/core/src/loop/build.ts`, `check.ts`, `falsify.ts`; `packages/core/test/build.test.ts`, `check.test.ts`, `falsify.test.ts` |
| Holdback records where it first saw a spec change (`spec.changed`, with the sealed and current sha256). Seen right after an agent turn, or while an interactive session runs, its origin is unverified: `run` and `watch` stop loudly instead of re-planning it, and `holdback drift` shows the diff and asks you in the terminal to accept it as yours, whatever `--answers` says. Its commit says `origin unverified`. | REPRODUCIBLE | `packages/core/src/loop/spec.ts` (`specChangeEvent`, `specDiff`), `packages/cli/src/run.ts`, `watch.ts`, `drift.ts`; `packages/core/test/build.test.ts`, `drift.test.ts`, `specdiff.test.ts`, `packages/cli/test/cli.test.ts` |
| The guard denies an Edit, Write or shell write (`>`, `>>`, `tee`, `sed -i`, `cp`/`mv`, `Set-Content`, `Out-File`, `Add-Content`) aimed at a spec file and logs it in Holdback's home, as does the interactive post-edit hook for a save that got through. A spec change in a window with such an attempt on record (the agent's turn; for an interactive session, everything since the seal) is a tamper. | REPRODUCIBLE | `packages/core/src/agent/guard.ts`, `attempts.ts`, `packages/cli/src/hooks.ts`; `packages/core/test/guard.test.ts`, `guard-main.test.ts`, `attempts.test.ts`, `build.test.ts`, `check.test.ts`, `packages/cli/test/hooks.test.ts` |
| A Kane run that fails for a reason other than the app (its environment, its automation, a timeout, a crash) is re-run once. It is never briefed and never counts as a catch, and it keeps the gate shut. | REPRODUCIBLE | `packages/core/src/kane/outcome.ts`; `packages/core/test/testmd.test.ts` (with the live captures), `build.test.ts`, `falsify.test.ts` |
| A planted bug Kane catches proves its criterion. One it misses makes the criterion vacuous and sends its use case back to Kane, for your approval. | REPRODUCIBLE | `packages/core/src/loop/falsify.ts`; `packages/core/test/falsify.test.ts` |
| A spec edit reopens the work: Kane plans the change, you approve, the changed criteria are owed. | REPRODUCIBLE | `packages/core/src/loop/drift.ts`; `packages/core/test/drift.test.ts` |
| A criterion that passed and then fails is bisected to the turn that broke it, and the brief names that turn. | REPRODUCIBLE | `packages/core/src/loop/bisect.ts`; `packages/core/test/bisect.test.ts` |
| The agent cannot run the human's Holdback commands (`reseal`, `spec`, `run`, `drift`, `watch`, `init`, `clean`, `serve`, `hook`). The CLI refuses them inside Claude Code, and the guard denies them in any shell command: by path or shim, behind `npx`, an env prefix (`env -u CLAUDECODE …`), `cmd /c` or `powershell -c`. `holdback status` and `holdback owed` stay open. | REPRODUCIBLE | `packages/core/src/agent/guard.ts`, `packages/cli/src/context.ts` (`refuseInsideClaudeCode`); `packages/core/test/guard.test.ts`, `packages/cli/test/hooks.test.ts` |
| In interactive mode, Kane checks after every Edit or Write and wakes the agent on a failure. A stop is refused while a criterion is owed; after 5 refusals in a row the human takes over. | REPRODUCIBLE | `packages/cli/src/hooks.ts`; `packages/cli/test/hooks.test.ts` |
| The breaker's key never reaches the agent or the app. | REPRODUCIBLE | `packages/cli/src/context.ts` (`scrubAgentEnv`), `packages/core/src/loop/build.ts`; `packages/cli/test/cli.test.ts` |
| Headless agent turns load no user-level Claude Code plugins, hooks or MCP servers. | REPRODUCIBLE | `packages/core/src/agent/claude.ts` (`--setting-sources project,local --strict-mcp-config`); `packages/core/test/claude-run.test.ts` |
| Kane spend is read from `kane-cli balance` before and after every Kane batch, next to Kane's per-run figures. | REPRODUCIBLE | `packages/core/src/ledger/credits.ts`; `packages/core/test/ledger.test.ts`, `build.test.ts` |
| The dashboard replay shows the state the live server reports for the same ledger. | REPRODUCIBLE | `apps/dashboard/test/parity.test.ts` |
| The 22 exam files match the hashes registered before any build. | REPRODUCIBLE | `eval/PREREGISTERED.md`; `eval/prd.test.ts`, `eval/reference.test.ts` |
| Every pending figure in these docs is rendered from a file, never typed. | REPRODUCIBLE | `scripts/render-readme.mjs`, `docs/demo-run.json`; `eval/render-readme.test.ts` |

## Modeled

| Claim | Tag | Evidence |
| --- | --- | --- |
| The agent's bug report for the caught ac-2 bug reads as in JUDGES.md step 5. | MODELED | rendered by `buildBrief` from the recorded falsify verdict, as if it came from a build turn; never sent to an agent |
| In the first live run, authoring cost about 16 Kane credits and about 40 seconds per test step. | MODELED | t-1 and t-2: 65.31 and 63.20 credits for 4 authored steps each, 32 to 48 s per step (ledger) |

## Pending

| Claim | Tag | Evidence |
| --- | --- | --- |
| <!-- headline:start -->Exam pending: Holdback's build and Claude Code alone have not been scored yet on the held-out 22-case exam ([pre-registration](eval/PREREGISTERED.md)).<!-- headline:end --> | <!-- exam-status:start -->NOT-CLAIMED (pending)<!-- exam-status:end --> | `eval/results/summary.json`, rendered by `pnpm render-readme`; registered in `eval/PREREGISTERED.md` |
| The pre-registered expectation: Holdback scores at least as high as each other arm, and the other arms claim done with at least one case failing. | NOT-CLAIMED until scored | `eval/PREREGISTERED.md`, "Expectation" |
| The recorded demo run ([JUDGES.md](JUDGES.md#3-the-recorded-ledger-and-screenshots) step 3). | <!-- demo-status:start -->NOT-CLAIMED (pending)<!-- demo-status:end --> | `docs/demo-run.json`, `examples/recorded-run/` |

## Not claimed

- **OS-level isolation of the verifier.** It is a seal, a guard hook, deny rules and hashes, not a sandbox. The threat model is an agent that optimizes toward green, not one that attacks Holdback.
- **A guard that stops obfuscated shell.** It is best-effort. For example, `git -c` keys on an allowed read-only subcommand (a diff driver, a pager) can still run a command, and a command name assembled at run time (`$(echo hold)back reseal`) gets past the check for the human's Holdback commands. A re-seal is logged in the ledger either way.
- **A view the agent cannot change.** `status` and `owed` decide what to show by reading the `CLAUDECODE` variable. An agent with shell access can unset it and see the human view, which can name Holdback's folders and Kane's test files, and says which Kane runs proved nothing and why.
- **Telling who changed the spec.** Holdback knows only where it first saw a change, not who made it. A change made by a process the agent left running after its turn, or a shell write the guard does not recognise (a script, an assembled command), can be first seen outside the agent's turn and then reads as an ordinary spec edit (drift). A change in the agent's turn with no attempt on record reads as drift of unverified origin, not as a tamper. Logging an attempt is best effort: one that cannot be written is still denied, but not on record.
- **Instant notice of Bash edits to git-ignored files.** In interactive mode they are not noticed until the next Edit or Write.
- **A sealed window while Kane runs.** The app the agent wrote runs as your user while Kane tests it, so in that window it could change files Holdback seals. That window is outside the threat model.
- **Privacy from Kane CLI's cloud.** Kane uploads test runs, screenshots and the pages it saw to LambdaTest Test Manager (`upload.performed: true` in every captured run under `packages/core/test/fixtures/kane/`). Holdback passes no option to change that.
- **Redacted Kane evidence.** Kane's evidence packs in the verifier folder stay as Kane writes them. Only the public fixture drops them (`apps/dashboard/scripts/sanitize-ledger.mjs`).
- **Low Kane cost.** In the first live run, authoring cost about 16 credits per test step, and a test that keeps failing is authored again on every run.
- **The planted-bug pass started by `holdback run`.** In the first live run the gate never opened. The pass ran the same `runFalsify` code from a script while the gate was shut, with real Kane and the real breaker.
- **The full loop live.** A Kane bug report reaching the agent and the agent fixing it, spec edits reopening work, re-design of a vacuous criterion, bisect, the interactive hooks with real Kane, re-runs of inconclusive tests and balance metering are built and unit-tested, not run live yet.
- **Stable criterion ids across a re-design.** Whether Kane keeps a criterion's id when it re-designs a use case is not verified live.
- **Other platforms.** Holdback has run live on Windows only.
- **An npm package.** Install from source.
- **Results beyond one spec.** The exam measures one spec, `examples/pantry-spec/PRD.md`.
- **Anything marked pending.** It is not claimed until the file behind it exists.
