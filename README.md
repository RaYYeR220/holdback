# Holdback

<!-- headline:start -->Exam pending: Holdback's build and Claude Code alone have not been scored yet on the held-out 22-case exam ([pre-registration](eval/PREREGISTERED.md)).<!-- headline:end -->

Holdback holds back a coding agent's "done" until Kane CLI proves every acceptance criterion of your spec in a real browser. You write only the spec. Kane designs the criteria and the tests, Claude Code builds from Kane's bug reports, and a criterion counts as proved only after Kane catches a bug planted to break it.

<!-- links:start -->Landing page: pending · Demo video: pending · Dashboard replay: pending<!-- links:end -->

![How Holdback holds back "done"](docs/architecture.svg)

Solid arrows ran in the first live run, whose ledger is in [`apps/dashboard/fixtures/ledger.jsonl`](apps/dashboard/fixtures/ledger.jsonl). Dashed arrows are built and covered by unit tests but have not run live yet. [CLAIMS.md](CLAIMS.md) gives the evidence for each.

## What it does

1. **You write the spec.** A `PRD.md` in your app's folder. It is the only thing you write.
2. **Kane designs the checks.** Kane CLI's assurance commands read the spec and ask you about what is ambiguous. Then they design acceptance criteria, each citing the spec line it comes from, and browser tests for them. You approve. Holdback keeps the tests in a verifier folder outside your repo (`~/.holdback/<id>/verifier/`) and seals them with sha256 hashes.
3. **The agent works only from bug reports.** Each turn, Claude Code gets a brief of the criteria still owed. When a Kane run fails, the brief carries Kane's bug report: the criterion, the spec line, the step Kane ran, what it saw, its diagnosis and a screenshot. It never carries the test file.
4. **"Done" is held back.** After every turn, Holdback starts the app and Kane runs the sealed tests in a real browser. The gate opens only when every criterion passes.
5. **A planted bug tests the tests.** For each passing criterion, a breaker on a different model writes the smallest patch that should break it, in a throwaway git worktree. Kane replays that criterion's tests with healing off. If Kane catches the bug, the criterion is proved. If it misses, the criterion is vacuous, and Holdback tells Kane (never the agent) what slipped through: Kane evolves the use case's tests, every criterion of the use case is owed again, and the next pass plants the same bug, which the new tests must now catch.
6. **Spec edits reopen the work.** Edit the spec and Kane plans the change (`holdback drift`, or automatically in `run` and `watch`). You approve, and the new or changed criteria are owed again.
7. **Tampering fails closed.** If something Holdback sealed changes behind its back, the gate stays shut until you look and run `holdback reseal`. That covers the tests, the spec, the config, Kane's recordings, the ledger, and `.git/config` keys that make git run code.

A Kane run that fails for a reason other than the app is re-run once: Kane's verdict blames its environment or its own automation, or the run timed out or crashed. If it still proves nothing, it is never sent to the agent and never counts as a catch. The gate stays shut and `holdback status` tells you why.

## Who it is for

Developers who hand a feature to a coding agent and want "done" to mean the spec holds in a browser, checked by tests the agent can neither read nor edit. It fits apps with a browser UI and a written spec. It is not a unit-test runner.

## Why it exists

An agent that writes its own tests also decides what passing means. A green build from a self-verified agent proves little: the same reasoning wrote the code and the check, and the cheapest path to green is to bend the check. The verifier has to be independent. In Holdback, Kane designs the checks from the spec, they live outside the repo, the agent only sees what failed, and every proved criterion has survived a bug planted to break it.

## Quick start

Holdback is installed from source for now. Clone this repository, then:

```sh
pnpm i
pnpm -r build
cd packages/cli
npm link            # puts `holdback` on your PATH
```

Run `npm link` inside `packages/cli`: `npm link ./packages/cli` from the root fails on the workspace dependency.

Then, in your app's folder (a git repository with a `PRD.md`):

```sh
holdback init       # writes holdback.config.json and the verifier folder
holdback spec       # Kane asks and designs, you approve, Holdback seals
holdback run        # Claude Code builds until every criterion passes, then planted bugs
```

`holdback status` shows every criterion and the gate at any time.

**Interactive mode.** To work in your own Claude Code session instead of a headless run:

```sh
holdback init --agent claude   # hooks and a skill in .claude/; run `holdback spec` first
claude                         # work as usual
```

After every Edit or Write, Kane checks the app in the background and wakes the agent with a bug report when it finds a failure. Claude Code cannot stop while a criterion is owed; after 5 refused stops in a row it hands over to you. `holdback init --agent claude --remove` takes the hooks out again.

`init --agent claude` also sets `permissions.blockReadsOutsideWorkingDirectories: true` in the project's `.claude/settings.json`. That keeps the agent out of the verifier folder, and it applies to your own Claude Code sessions in this project too: they cannot read files outside it either. `--remove` takes it out with the hooks.

**Scripted answers.** `spec`, `run`, `drift` and `watch` take `--answers <file>`, a JSON file outside the app folder: `{"answers": {"q1": "..."}, "default": "recommended", "approve": "all"}`. `spec`, `run` and `drift` also take `--dashboard`, which asks in the browser instead of the terminal. An answers file never accepts a spec change of unverified origin (see [Spec changes](#spec-changes)): that takes a yes typed in the terminal.

**Before `holdback spec`.** The config is sealed with the spec, so set everything in `holdback.config.json` first: changing it by hand later is a tamper (`holdback reseal` lifts it). For one run, use `--max-turns` and `--kane-cap` instead of editing the file. If your app's behaviour depends on the date or the time (bookings, opening hours, "today's" lists), pin them in `start.env`, the way the exam does, so every Kane run sees the same day:

```json
{ "start": { "env": { "HOLDBACK_TODAY": "2026-11-19", "HOLDBACK_NOW": "08:00" } } }
```

Your app has to read those variables, as the pantry spec's stack notes ask. Pick a date the spec's rules allow (for the pantry, a Tuesday, Thursday or Saturday).

**Your app's data.** Every time Holdback starts your app for Kane (each turn's checks, a re-run, the hooks' check, a planted bug, a bisect probe, the closing replay), it sets `DATA_DIR` to a new, empty folder under `~/.holdback/<id>/data/`, over anything `start.env` says. Keep your app's state there: then rows one Kane run writes (a booking, a sign-up) never meet the next run, and a replay of the same steps meets the same empty app. The newest few folders stay for debugging. The agent's own check that the app boots gets a scratch `DATA_DIR` outside the repo too: a new temporary folder for each headless turn, and in interactive mode a folder in your user cache (`%LOCALAPPDATA%\holdback\agent-data\<id>` on Windows, else `~/.cache/holdback/agent-data/<id>`) that `init --agent claude` sets in `.claude/settings.json`, unless you set a `DATA_DIR` there yourself. If your app still writes a `data/` folder in the repo when you start it by hand, put it in `.gitignore`: falsify refuses to plant bugs while the work tree has uncommitted changes.

## Requirements

- Node 24 or later, and pnpm 9 to build from source.
- git. Holdback commits each agent turn and plants bugs in worktrees.
- Kane CLI 0.10.4 or later, logged in (`kane-cli login`), with credits (`kane-cli balance`).
- Claude Code (`claude` on your PATH, logged in).
- Optional: `VENICE_API_KEY` for the breaker. Without it, use `holdback run --no-falsify`; the build loop works, the planted-bug pass does not run.
- Your app starts with one command and listens on the port in the `PORT` environment variable.

Kane bills credits for designing and authoring tests. In the first live run, authoring cost about 16 credits and 40 seconds per test step; [JUDGES.md](JUDGES.md#6-run-it-yourself) has the figures.

## Configuration

`holdback init` writes `holdback.config.json` in your app's folder. A key you leave out takes its default (`packages/core/src/project.ts`). The file is sealed: an edit by the agent is a tamper.

| Key | Default | What it does |
| --- | --- | --- |
| `spec` | `["PRD.md"]` | Spec files in the app folder that Kane reads. |
| `specUrls` | `[]` | Links Kane reads as spec sources. |
| `agentNotes` | unset | A stack and style notes file the agent's brief points to, e.g. `STACK.md`. |
| `start.cmd` | `"npm start"` | The command that starts your app. |
| `start.port` | `3100` | The port passed to the app in `PORT`. Holdback refuses a port another program already uses. |
| `start.readyPath` | `"/"` | The path polled until the app answers. |
| `start.env` | unset | Extra environment for the app, e.g. a pinned `HOLDBACK_TODAY` and `HOLDBACK_NOW`. `DATA_DIR` here is overridden: each start gets its own (see [Your app's data](#quick-start)). |
| `agent.kind` | `"claude"` | The coding agent. Claude Code is the only one. |
| `agent.model` | unset | Model passed to Claude Code (`--model`); unset uses Claude Code's default. |
| `agent.maxTurnsPerCall` | `60` | `--max-turns` for each Claude Code call. |
| `kane.parallel` | `3` | Kane tests run at once. |
| `kane.timeoutS` | `120` | Kane's `--timeout`, which applies to each step. Holdback stops a whole run after this times its step count, plus 30 seconds, so a hung test costs minutes, not an hour. |
| `kane.capCredits` | `null` | The most Kane credits this project may spend, as measured on the ledger (the `Kane credits` figure in `holdback status`). No Kane batch, and no agent turn, starts once it is reached; the command stops with exit 3. `null` is no cap; `--kane-cap` overrides it for one command. |
| `kane.designMax` | `5` | Passed as `kane-cli design tests --max`: the most scenarios Kane designs per use case, one test each. It does not limit a test's steps. |
| `breaker.model` | `"deepseek-v4-flash"` | The breaker's model on the Venice API. |
| `breaker.capUsd` | `2` | The most the breaker may spend for this project, in USD, across runs. |
| `loop.maxTurns` | `15` | The highest turn number. Turns are numbered across runs; `--max-turns` overrides it. |
| `loop.denyWeb` | unset | `true` takes WebFetch and WebSearch away from the agent. |
| `loop.appendClarifications` | `"always"` | Where your answers to Kane go: `"always"` appends them to `PRD.md`; `"spec-only"` only in the spec stage, so later answers stay in the ledger. |

| Environment variable | What it does |
| --- | --- |
| `VENICE_API_KEY` | The breaker's key. The agent and the app never see it: Holdback blanks it in their environment. |
| `HOLDBACK_HOME` | Where the per-project verifier folders and ledgers live. Default `~/.holdback`; a relative path is resolved against the folder you run Holdback in. The coding agent never gets it, nor any other `HOLDBACK_*` variable. |
| `HOLDBACK_KANE_BIN` | The Kane CLI binary. Default `kane-cli`. |
| `HOLDBACK_CLAUDE_BIN` | The Claude Code binary. Default `claude`. |
| `HOLDBACK_GUARD_LOG` | A file the guard hook appends each decision to, for debugging. Holdback hands it to the guard on its command line, not through the agent's environment. |

## Commands

| Command | What it does | Exits |
| --- | --- | --- |
| `holdback init [--spec <file>] [--url <url>] [--start <cmd>] [--port <n>] [--force]` | Writes `holdback.config.json` and creates the verifier folder. | 0, 1 |
| `holdback init --agent claude [--remove]` | Installs (or removes) the Claude Code hooks and skill for interactive mode. | 0, 1 |
| `holdback spec [--answers <file> \| --dashboard] [--kane-cap <n>]` | Kane designs criteria and tests from the spec; you answer and approve; Holdback seals them. What you leave unticked in the design approval is rejected: never owed, never run. Once anything is sealed it refuses (a later spec change goes through `drift`); a stage cut short resumes where it stopped. | 0, 1, 2, 3 |
| `holdback run [--max-turns <n>] [--no-falsify] [--answers <file> \| --dashboard] [--kane-cap <n>]` | Builds until Kane proves every criterion, then falsifies the passing ones, and builds again while falsify leaves criteria owed. Runs drift first when the spec changed. Checks `VENICE_API_KEY` before it builds, unless `--no-falsify`. | 0, 1, 2, 3, 130 |
| `holdback drift [--answers <file> \| --dashboard] [--kane-cap <n>]` | Applies a spec edit made after the last seal: shows the diff from the sealed spec, then Kane re-plans with you. | 0, 1, 2, 3 |
| `holdback watch [--max-turns <n>] [--no-falsify] [--answers <file>] [--kane-cap <n>]` | Watches the spec; on every edit runs drift, then the run loop, until Ctrl-C. An edit made while it builds stops the build and goes through drift on the next pass. | 1, 2, 3, 130 |
| `holdback status [--json]` | Every criterion and whether the gate is open, why a criterion is vacuous or needs the spec, and each time Kane evolved a use case (minted and retired tests, and what it was told slipped through; the coding agent never sees that part). | 0, 1, 2 |
| `holdback owed` | What the coding agent is told is still owed. | 0, 1, 2 |
| `holdback reseal [--yes]` | Accepts the files on disk as the new sealed state, which lifts a tamper. It refuses when only the spec changed (that is drift), and after a tamper it keeps a changed spec's old seal, so drift still re-plans it and the change stays of unverified origin. | 0, 1, 2 |
| `holdback clean` | Removes leftover mutant and bisect worktrees, waiting for a check in flight. Never delete them by hand: they link into your app's `node_modules`. | 0, 1, 2 |
| `holdback serve [--port <n>] [--static <dir>]` | The local dashboard on 127.0.0.1 (default port 4317): ledger, gate, live events, and answering Kane from the browser. | 0, 1 |
| `holdback hook <guard\|post-edit\|stop\|prompt>` | The Claude Code hook entry point that `init --agent claude` installs. | hook protocol |

`spec`, `run`, `drift`, `watch`, `reseal`, `serve` and `init --agent claude --remove` are yours, not the agent's: they refuse to run inside a Claude Code session. The guard hook denies them, and `init`, `clean` and `hook` as well, in the agent's own shell commands: by any path, behind `npx`, an env prefix, `cmd /c` or `powershell -c`. `init`, `clean` and `hook` themselves do not check for a Claude Code session; only the guard keeps the agent off them. `status` and `owed` stay open to the agent.

### Spec changes

Editing the spec after the seal is drift, not a tamper: Kane re-plans the criteria with you (`holdback drift`, or `holdback run`, which runs it first). An edit made while `run` builds stops it (exit 3) with Kane's results so far kept, and the agent's turn is committed without the spec. `watch` takes it into drift on its next pass.

Holdback cannot tell who edited the spec, so it fails closed. A change counts as yours only when no agent turn has started since the last seal or drift; otherwise its origin is unverified. Then `run` stops instead of re-planning it, and `drift` and `watch` show you the diff from the sealed spec and go ahead only on a yes typed in the terminal (an answers file never gives it). If the guard saw the agent try to write the spec since the last seal, the change is a tamper. The coding agent cannot edit the spec: its Edit and Write are denied by rule, and the guard denies shell writes onto it.

Only a drift you approve in the terminal settles an unverified change. `holdback reseal` after a tamper keeps the spec's old seal and records the change as unverified, so an answers file still cannot approve it. Drift re-plans and seals exactly the spec bytes whose diff it showed you, plus the Clarifications Holdback appends: if the spec changes again while Kane re-plans it, nothing is sealed, the change is recorded as unverified and drift stops with exit 3, leaving the newer edit in place for you to review. A line in Holdback's log of the agent's spec write attempts that cannot be read counts as an attempt only for the stretch of time it was written in; a seal after it leaves it behind.

| Exit code | Meaning |
| --- | --- |
| 0 | Success. For `run`: the gate is open and every criterion is proved or passing. |
| 1 | An error, or not finished (for example, the turn limit was reached). |
| 2 | Tamper: something sealed changed. Nothing counts until you run `holdback reseal`. |
| 3 | `run` finished but the gate is not fully green: criteria are still owed, vacuous or need the spec, or Kane could not finish checking a test. Also: the spec changed while it ran (run `holdback drift`), or the Kane credit cap was reached (any command). |
| 130 | Interrupted. One Ctrl-C stops after the current step; a second quits at once. |

### Planted bugs that get through

When a planted bug survives every test of a criterion, Holdback runs `kane-cli maintain evolve <use case> --because "<what slipped through>"` in the verifier and answers Kane's own re-design question. The reason is the breaker's account of its bug in a user's terms: the inputs, what the page should show and what it showed. Kane sees it; the coding agent never does. Kane's new tests replace the use case's old ones (it retires them all, even when asked to keep them), Holdback seals them with Kane as their author (if the evolve added, changed or removed any other sealed file of the verifier, such as a variable or another use case's test, that is a tamper and nothing is sealed), and every criterion of the use case is owed again: the build loop runs the new tests and, when they pass, falsify plants the same bug again. It must now be caught, or the criterion stays vacuous. If the new set leaves a criterion of the use case without a test, one follow-up evolve asks Kane to cover it again; still uncovered, it needs the spec. An evolve that adds no test leaves the criterion vacuous with that reason, and is not retried. Kane evolves a use case at most twice per `holdback run`, under the Kane credit cap, at about 11 credits each (live, on the pantry spec).

## Honest limits

- The verifier is sealed, guarded and hashed, not sandboxed. Holdback does not isolate it at the OS level.
- Human-only commands are refused by an env check (`CLAUDECODE`) plus the guard hook's command rule. Both are best-effort against an agent that disguises its shell commands, and so is the guard's rule against shell writes onto the spec.
- Holdback cannot tell who changed the spec. It treats a change as yours only before any agent turn since the last seal, and asks you otherwise.
- In interactive mode, Bash edits to git-ignored files are not noticed until the agent's next Edit or Write.
- Kane CLI is a cloud service. Test runs, screenshots and the pages Kane saw are uploaded to LambdaTest Test Manager.
- Authoring is slow and billed per step, and a failing test re-authors on every run.
- Kane's evolve after a surviving bug replaces every test of the use case. A criterion the new tests no longer cover gets one follow-up evolve, then needs the spec, so a stronger test for one criterion can cost coverage of another.
- Holdback has run live on Windows only so far.
- Figures marked pending are not claimed yet.

[CLAIMS.md](CLAIMS.md) tags every public statement with its evidence and lists what is not claimed.

## Results

<!-- results:start -->
Results pending.
<!-- results:end -->

The exam, its hashes and the expected outcome were committed before any arm was built: [eval/PREREGISTERED.md](eval/PREREGISTERED.md).

## For reviewers

- [JUDGES.md](JUDGES.md): a 5-minute path that needs no credentials, and how to run it yourself.
- [CLAIMS.md](CLAIMS.md): every claim, tagged with the file or script behind it.
- [MOCKS.md](MOCKS.md): what is real and what is simulated.
- [FINDINGS.md](FINDINGS.md): what building on Kane CLI 0.10.4 taught us.
- [eval/PREREGISTERED.md](eval/PREREGISTERED.md): the held-out exam.

## Development

```sh
pnpm -r build        # every package, the dashboard (live and replay) and the landing page
pnpm -r test         # unit tests; no Kane, Claude Code or Venice calls
pnpm -r typecheck
pnpm render-readme   # fills the generated parts of README.md, JUDGES.md and CLAIMS.md
```

The dashboard's browser tests need Playwright's Chromium: run `npx playwright install chromium` in `apps/dashboard` on a fresh machine.

| Folder | What is in it |
| --- | --- |
| `packages/core` | The loop: Kane and Claude Code wrappers, ledger, gate, seal, guard, breaker, falsify, drift, bisect, local server. |
| `packages/cli` | The `holdback` command and the Claude Code hooks. |
| `apps/dashboard` | The dashboard: live (served by `holdback serve`) and a static replay of a recorded ledger. |
| `apps/site` | The landing page. |
| `eval` | The pre-registered exam, the arm runner and the scorer. |
| `examples/pantry-spec` | The spec the exam is written against. |

## License

[MIT](LICENSE)
