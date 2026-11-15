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
5. **A planted bug tests the tests.** For each passing criterion, a breaker on a different model writes the smallest patch that should break it, in a throwaway git worktree. Kane replays that criterion's tests with healing off. If Kane catches the bug, the criterion is proved. If it misses, the criterion is vacuous and Kane re-designs its tests for your approval.
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

**Scripted answers.** `spec`, `run`, `drift` and `watch` take `--answers <file>`, a JSON file outside the app folder: `{"answers": {"q1": "..."}, "default": "recommended", "approve": "all"}`. `spec`, `run` and `drift` also take `--dashboard`, which asks in the browser instead of the terminal.

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
| `start.env` | unset | Extra environment for the app. |
| `agent.kind` | `"claude"` | The coding agent. Claude Code is the only one. |
| `agent.model` | unset | Model passed to Claude Code (`--model`); unset uses Claude Code's default. |
| `agent.maxTurnsPerCall` | `60` | `--max-turns` for each Claude Code call. |
| `kane.parallel` | `3` | Kane tests run at once. |
| `kane.timeoutS` | `420` | Kane's `--timeout`, which applies to each step. Holdback stops a whole run after this times its step count, plus a grace period. |
| `kane.designMax` | `5` | The most scenarios Kane designs per use case, each with one test. |
| `breaker.model` | `"deepseek-v4-flash"` | The breaker's model on the Venice API. |
| `breaker.capUsd` | `2` | The most the breaker may spend for this project, in USD, across runs. |
| `loop.maxTurns` | `15` | The highest turn number. Turns are numbered across runs; `--max-turns` overrides it. |
| `loop.denyWeb` | unset | `true` takes WebFetch and WebSearch away from the agent. |
| `loop.appendClarifications` | `"always"` | Where your answers to Kane go: `"always"` appends them to `PRD.md`; `"spec-only"` only in the spec stage, so later answers stay in the ledger. |

| Environment variable | What it does |
| --- | --- |
| `VENICE_API_KEY` | The breaker's key. The agent and the app never see it: Holdback blanks it in their environment. |
| `HOLDBACK_HOME` | Where the per-project verifier folders and ledgers live. Default `~/.holdback`. |
| `HOLDBACK_KANE_BIN` | The Kane CLI binary. Default `kane-cli`. |
| `HOLDBACK_CLAUDE_BIN` | The Claude Code binary. Default `claude`. |
| `HOLDBACK_GUARD_LOG` | A file the guard hook appends each decision to, for debugging. |

## Commands

| Command | What it does | Exits |
| --- | --- | --- |
| `holdback init [--spec <file>] [--url <url>] [--start <cmd>] [--port <n>] [--force]` | Writes `holdback.config.json` and creates the verifier folder. | 0, 1 |
| `holdback init --agent claude [--remove]` | Installs (or removes) the Claude Code hooks and skill for interactive mode. | 0, 1 |
| `holdback spec [--answers <file> \| --dashboard]` | Kane designs criteria and tests from the spec; you answer and approve; Holdback seals them. | 0, 1, 2 |
| `holdback run [--max-turns <n>] [--no-falsify] [--answers <file> \| --dashboard]` | Builds until Kane proves every criterion, then falsifies the passing ones. Runs drift first when the spec changed. | 0, 1, 2, 3, 130 |
| `holdback drift [--answers <file> \| --dashboard]` | Applies a spec edit made after the last seal. | 0, 1, 2 |
| `holdback watch [--max-turns <n>] [--no-falsify] [--answers <file>]` | Watches the spec; on every edit runs drift, then the run loop, until Ctrl-C. | 1, 2, 130 |
| `holdback status [--json]` | Every criterion and whether the gate is open. | 0, 1, 2 |
| `holdback owed` | What the coding agent is told is still owed. | 0, 1, 2 |
| `holdback reseal [--yes]` | Accepts the files on disk as the new sealed state, which lifts a tamper. | 0, 1, 2 |
| `holdback clean` | Removes leftover mutant and bisect worktrees. Never delete them by hand: they link into your app's `node_modules`. | 0, 1, 2 |
| `holdback serve [--port <n>] [--static <dir>]` | The local dashboard on 127.0.0.1 (default port 4317): ledger, gate, live events, and answering Kane from the browser. | 0, 1 |
| `holdback hook <guard\|post-edit\|stop\|prompt>` | The Claude Code hook entry point that `init --agent claude` installs. | hook protocol |

`spec`, `run`, `drift`, `watch`, `reseal`, `serve` and `init --agent claude --remove` are yours, not the agent's: they refuse to run inside a Claude Code session.

| Exit code | Meaning |
| --- | --- |
| 0 | Success. For `run`: the gate is open and every criterion is proved or passing. |
| 1 | An error, or not finished (for example, the turn limit was reached). |
| 2 | Tamper: something sealed changed. Nothing counts until you run `holdback reseal`. |
| 3 | `run` finished but the gate is not fully green: criteria are still owed, vacuous or need the spec, or Kane could not finish checking a test. |
| 130 | Interrupted. One Ctrl-C stops after the current step; a second quits at once. |

## Honest limits

- The verifier is sealed, guarded and hashed, not sandboxed. Holdback does not isolate it at the OS level.
- Kane CLI is a cloud service. Test runs, screenshots and the pages Kane saw are uploaded to LambdaTest Test Manager.
- Authoring is slow and billed per step, and a failing test re-authors on every run.
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
