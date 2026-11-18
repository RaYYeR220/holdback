# Real and simulated

## The product path has no mocks

`holdback spec`, `run`, `drift`, `watch` and the Claude Code hooks call the real Kane CLI (`kane-cli`), the real Claude Code (`claude`), the real Venice API (the breaker) and git. Nothing in `packages/core/src` or `packages/cli/src` simulates them. `HOLDBACK_KANE_BIN` and `HOLDBACK_CLAUDE_BIN` only choose which binary runs, so the tests can swap in the stand-ins below.

`--answers <file>` stands in for the human, not for a service: Kane still asks, and the file answers and approves.

## Unit tests use stand-ins

`pnpm -r test` makes no Kane, Claude Code or Venice call.

| Stand-in | Used by | What it does |
| --- | --- | --- |
| `packages/core/test/fake-kane.mjs` | core tests, through `HOLDBACK_KANE_BIN` | Prints a recorded NDJSON fixture, or one per call from a sequence file; can hang or exit with a given code |
| `packages/core/test/fake-claude.mjs` | core tests, through `HOLDBACK_CLAUDE_BIN` | Prints a stream-json transcript (success, error, killed or hanging) and records its arguments, stdin and environment |
| `eval/test/fake-kane-exam.mjs` | `eval/score.test.ts` | Passes, fails or reports an environment failure per exam file |
| `eval/test/app.mjs` | `eval/score.test.ts` | A stand-in for an arm's app that records the environment it started with |
| `packages/core/test/fixtures/tiny-server.mjs` | `packages/core/test/app.test.ts` | A minimal HTTP server for the app-start tests |
| Injected functions | build, check, falsify, drift, bisect and CLI tests | The loop's Kane runs, agent turns and balance reads, passed in as functions |
| A stubbed `fetch` | `packages/core/test/breaker.test.ts` | The Venice API's replies |

## Recorded fixtures

The fake Kane replays real Kane CLI 0.10.4 output. Home paths, temp folders and Test Manager share links were replaced (`scripts/sanitize.mjs`: `~`, `<tmp>`, `<share-url>`).

| Fixture | Recorded from |
| --- | --- |
| `packages/core/test/fixtures/kane/01-ingest.ndjson` to `10-list-derived.ndjson`, `context-commits/`, `context-view.json`, `cover-gaps.json` and `tests/` | Real Kane CLI runs on the same 4-rule spec as the first live run, recorded before Holdback's loop was built: ingest, extraction, design, authoring, replay, a mutant replay, reconcile, listing and coverage |
| `packages/core/test/fixtures/kane/11-heal-replay-t1.ndjson` | The first live run: a replay that failed, healed itself and passed |
| `packages/core/test/fixtures/kane/12-env-failure-t3.ndjson` | The first live run: an authoring run broken off by an `environment_issue` |
| `packages/core/test/fixtures/kane/13-design-force-nothing-to-change.ndjson` | `kane-cli design tests --use-case uc-1 --force` on a copy of the first live run's verifier (2026-11-15): Kane kept the design and reported `nothing_to_change` |
| `packages/core/test/fixtures/kane/14-evolve-paused.ndjson`, `15-evolve-complete.ndjson`, `18-evolve-told-to-keep.ndjson`, `tests/nine-person-household-earning-9-000-uses-the-9-467-limit_test.md` | `kane-cli maintain evolve uc-1 --because "…"` on a copy of the pantry verifier (2026-11-15): Kane's re-design question, then the evolve answered with `--answer evolve:uc-1=1`, the one told to keep every old test, and the test Kane minted |
| `packages/core/test/fixtures/kane/19-design-resume-finished-session.ndjson`, `20-design-message-without-resume.ndjson` | The same session: `design tests --resume` of a finished session, and `--message` without `--resume` |
| `apps/dashboard/fixtures/ledger.jsonl`, `config.json`, `artifacts/` | The pantry run's ledger (2026-11-16 to 18), its config and the 19 screenshots it names, sanitized by `apps/dashboard/scripts/sanitize-ledger.mjs` (home paths, share links and Kane's evidence packs removed): the dashboard replay and its parity and browser tests read it |
| `examples/first-live-run/ledger.jsonl`, `config.json`, `artifacts/` | The first live run's ledger (2026-11-15), config and the 3 screenshots it names, sanitized the same way: the dashboard's model and live-server tests read it |
| `packages/core/test/fixtures/rehearsal/ledger.jsonl` | The live rehearsal's ledger (2026-11-16), sanitized the same way (its screenshots left out): the verdict, retired-test and CLI/dashboard parity tests read it |
| `packages/core/test/fixtures/kane/rehearsal-start-navigation.json` | Kane's own session files of the live rehearsal (start-URL override, the first navigate and its error, which sessions overlapped), sanitized by `scripts/sanitize.mjs`: the evidence for [FINDINGS.md](FINDINGS.md) finding 13, read by no test |
| `packages/core/test/fixtures/kane/variables-declared-empty.json`, `import-absolute-windows_test.md` | The pantry run's spec stage (2026-11-16): the variables file `design tests` wrote, its owner variables empty (`start_url` filled by Holdback), and a test it wrote with an `@import` of an absolute Windows path after `./` (its home path renamed): the evidence for findings 15 and 16 |
| `packages/core/test/fixtures/venice/pilot-reasoning-none.json` | One live Venice call (2026-11-16): `deepseek-v4-flash` with `reasoning_effort` "none", the fields Holdback reads |
| `packages/core/test/fixtures/venice/rehearsal-cut-off.json`, `rehearsal-truncated-json.json` | The live rehearsal's cut-off breaker replies, rebuilt from its ledger (the content it kept and the billed tokens); the `_recorded` field of each says which parts are recorded |

Three fixtures are written for the tests, not recorded: `noise.txt`, a plain-text line mixed into NDJSON, to check that Holdback keeps Kane's raw stdout; `16-evolve-nothing-to-change.ndjson`, an evolve that finds nothing to change; and `17-evolve-cover-again.ndjson`, a follow-up evolve that covers criteria again. The two evolve fakes follow the event shapes of the recorded evolve.

`context-commits/000001-*.json` records the same source id (`sha256:0da9b627…`) as the first live run's `spec.ingested` event: both ingested the same spec.

## The eval is real

Arms A, B and C are real builds: Claude Code alone (A), Claude Code with its own Kane checks (B), and Holdback driving Claude Code (C). Each finished app is scored once by the real Kane CLI on the 22 exam files. Nothing in the eval is simulated. The runner is `eval/run-arm.ts`, the scorer `eval/score.ts`, and the arms' prompts and their sources are in `eval/arms/` (`eval/arms/PROVENANCE.md`). The results are in `eval/results/`: the scores in `summary.json` and `a.json`, `b.json`, `c.json`, the builds in `a-run.json`, `b-run.json`, `c-run.json` (each arm's app folder named by a label, not a path).

## Pending means not measured

The landing page and the dashboard show "pending" wherever a figure is not measured yet. That is a placeholder, not data:

- the landing page reads every figure from `apps/site/src/data/results.json`, where `null` means pending. Its `firstLiveRun` figures are copied from the first live run's ledger, its `demo` figures from the pantry run's (`docs/demo-run.json`) and its exam scores from `eval/results/summary.json`;
- the dashboard's exam board reads `eval/results/summary.json` at build time and shows pending without it;
- README.md, JUDGES.md and CLAIMS.md render their pending parts from `eval/results/summary.json` and `docs/demo-run.json` with `pnpm render-readme`.
