# Kane CLI findings

What Holdback found about Kane CLI 0.10.4. Each finding has its evidence in this repo, what Holdback does about it, and a suggestion. "The ledger" is the first live run's, `apps/dashboard/fixtures/ledger.jsonl`.

## 1. `--timeout` bounds each step, not the whole run

- **Seen:** t-3 has 11 steps and ran with `--timeout 420` (`kane.timeoutS` in `apps/dashboard/fixtures/config.json`). Its steps took 36 to 49 seconds each. At 450.9 seconds Kane was still running, and Holdback's own whole-run timer stopped it after 9 passed steps (the ledger's turn-1 `run` for t-3). The run billed 164.87 credits and saved nothing.
- **Holdback now:** passes `--timeout` as it is, and stops a run only after the timeout times the test's step count, plus 30 seconds (`packages/core/src/kane/testmd.ts`).
- **Suggestion:** say "per step" in `testmd run --help` ("Kill after N seconds" today), or add a separate whole-run limit.

## 2. A failing flow is authored again on every run

- **Seen:** t-2 passed in turn 1 and replayed in turn 2 for 0 credits (4 replay decisions, 0 author decisions). t-3 never passed, so turn 2 authored it again from the start (11 author decisions, 9.60 credits before it broke off). In turn 1, authoring cost 65.31 and 63.20 credits for two 4-step tests (the ledger).
- **What it means:** an agent loop whose test stays red pays the authoring price on every turn: about 16 credits a step in the first live run.
- **Holdback now:** logs the credits of every run and batch, so the cost shows in `holdback status`. A test that keeps failing for a reason other than the app stops the run (exit 3) instead of paying for more turns.
- **Suggestion:** cache the passed prefix of a failing flow, or offer a replay-only mode that fails fast where the recording ends.

## 3. `verdict.family` is the field an agent loop needs most

- **Seen:** `application_issue` on a planted bug (`packages/core/test/fixtures/kane/06-mutant-t3.ndjson`); `automation_bug` when a replay checked the result of an empty form ("Eligibility assertion ran with empty form values", `11-heal-replay-t1.ndjson`); `environment_issue` for "Browser target closed before screenshot capture" (`12-env-failure-t3.ndjson`).
- **What it means:** without the family, a loop tells the coding agent to fix a browser crash, and a flaky replay counts as a caught bug.
- **Holdback now:** `environment_issue`, `automation_bug`, a timeout and a crash are re-run once and never briefed to the agent. Any other family counts against the app (`packages/core/src/kane/outcome.ts`).
- **Suggestion:** document the families next to the exit codes, and say whether the list is closed.

## 4. The graph view renders gap titles as `[object Object]`

- **Seen:** the three gap nodes of `context view --json` have `"title":"[object Object]"`, and so does their rendered panel (`packages/core/test/fixtures/kane/context-view.json`).
- **Holdback now:** shows the gap's id instead (the ledger's `design` event: gap-1 to gap-3).
- **Suggestion:** render the gap's text.

## 5. `--answer q=<label>` is accepted when free text is not allowed

- **Seen:** both questions of the ingest have `allow_free_text: false` (`01-ingest.ndjson`; `allowFreeText: false` in the ledger's `spec.paused`). Holdback answered with an option's label, `Keep unspecified`, and Kane resumed and billed 1.40 credits (`spec.answered`).
- **What it means:** the output does not say whether Kane matched the label to an option or took it as free text.
- **Holdback now:** sends the label of the option chosen.
- **Suggestion:** document the forms `--answer` takes (index, label, free text), and reject free text where it is not allowed.

## 6. Every run is uploaded to Test Manager, healed replays included

- **Seen:** `test_md_summary.upload.performed: true` in every captured run: authoring, replays, a mutant replay, a healed replay and a run that broke off (`04`, `05`, `06`, `08`, `11` and `12` under `packages/core/test/fixtures/kane/`). Four of them carry a Test Manager share link.
- **What it means:** in a local agent loop, every iteration's screenshots and pages leave the machine.
- **Holdback now:** says so in [CLAIMS.md](CLAIMS.md).
- **Suggestion:** state it in the agent docs, and offer a documented way to keep a run local.

## 7. `kane-cli balance` is the only exact spend source

- **Seen:** Kane reports `credits_consumed` on the `run_end` event of each step it runs. A run stopped mid-step has no `run_end` for that step: the ledger's t-3 run reports 9 steps and 164.87 credits, though it was in its 10th step when it was stopped.
- **Holdback now:** reads `kane-cli balance` before and after every Kane batch and logs both figures (`packages/core/src/ledger/credits.ts`). `holdback status` shows the balance figure, with the per-run sum beside it when they differ.
- **Suggestion:** emit a final credits event when a run is cancelled or killed.

## 8. `design tests --max` bounds how many scenarios, not how long their tests are

- **Seen:** Holdback passes `kane.designMax` as `kane-cli design tests --max`, which caps the scenarios Kane designs per use case, one test each (`packages/core/src/kane/assurance.ts`). With `--max 3` (`apps/dashboard/fixtures/config.json`), Kane designed 3 tests of 4, 4 and 11 steps. The 11-step test is the one that timed out (finding 1).
- **What it means:** the cost of a design follows its total step count, which no flag bounds.
- **Suggestion:** a step limit for design, or the step count in the design output so a caller can ask for a split.

## 9. `design tests --force` on an unchanged spec designs nothing new

- **Seen:** forced on a use case whose spec had not changed, Kane kept every criterion, scenario and test, with the same ids and content hashes, reported `nothing_to_change` and billed 11.03 credits (`packages/core/test/fixtures/kane/13-design-force-nothing-to-change.ndjson`). In the same session, `--strength 3-wise` (13.5 credits) and `--phase scenarios` (5.7 credits) also ended in `nothing_to_change`, without a new scenario.
- **What it means:** a caller that knows a test is too weak (a planted bug got past it) cannot get a stronger one by re-designing: the design takes its direction only from the sources.
- **Holdback now:** never forces a re-design after a surviving bug; it asks Kane to evolve the use case with the reason (finding 11).
- **Suggestion:** say in `design tests --help` that `--force` re-runs the design on the same sources, and that it may change nothing.

## 10. A finished design session cannot be resumed, and a fresh one takes no message

- **Seen:** `design tests --resume <sid>`, with the `sid` of the `session_complete` event or the `session` of `run_start`, ends in `error SESSION_MISSING` and `done` `refused`, exit 2, at no cost (`packages/core/test/fixtures/kane/19-design-resume-finished-session.ndjson`). `--message` without `--resume` is refused: "--message only rides a resume … a fresh run takes its direction from the sources" (`20-design-message-without-resume.ndjson`).
- **What it means:** only a session paused on a question can be steered; there is no way to send a reason to a design once it has finished.
- **Holdback now:** steers through `maintain evolve --because`, which takes a reason on a fresh run.
- **Suggestion:** let `--message` start a fresh design of a use case, or document `maintain evolve --because` as the way to steer one.

## 11. `maintain evolve --because` mints targeted tests but retires every old test of the use case

- **Seen:** told what slipped through (a household of 9 checked against the 8-person limit, with the inputs and the expected result), `kane-cli maintain evolve uc-1 --because "…" --mode agent` paused on its own question (`evolve_paused`, `evolve:uc-1`, exit 3), and the same command with `--answer evolve:uc-1=1` minted one scenario and one test that catch it, for about 11.4 credits (`14-evolve-paused.ndjson`, `15-evolve-complete.ndjson`, and the test in `tests/nine-person-household-earning-9-000-uses-the-9-467-limit_test.md`). Its `evolve_diff` superseded all three old pairs (`retained: []`), and its `moves` left three criteria without a test. Asked in the reason to keep every existing scenario and test and add one, it did the same (`18-evolve-told-to-keep.ndjson`). The old test files stay on disk, unchanged, but are no longer live.
- **What it means:** an evolve is a re-design of the whole use case, not an addition: a caller that keeps running the old tests runs retired ones, and coverage of the other criteria can drop.
- **Holdback now:** takes Kane's new set as the use case's only tests, checks which criteria it left without a test (from the test files' `@verifies`), asks Kane once more to cover them, and marks any still uncovered as needing the spec.
- **Suggestion:** honour an explicit keep in the reason, or offer an additive mode (`--keep-existing`), and say in the `evolve_paused` rationale that every pair is superseded.

## 12. On Windows a free-text flag goes through cmd.exe twice

- **Seen:** `npm i -g @testmuai/kane-cli` installs `kane-cli.cmd`, which ends in `"%dp0%\node_modules\@testmuai\kane-cli\bin\kane-cli.cjs" %*`. A caller that runs `kane-cli` through a shell has its arguments parsed by cmd.exe once more at that `%*`: a `--because` holding `&`, `|`, `<`, `>`, `%VAR%` or an odd number of quotes is cut short, and the rest runs as commands in the caller's folder. A reason that quotes a criterion (`ac-2 ("…")`) is enough. Holdback's first evolve code did this through cross-spawn, which escapes once.
- **What it means:** text Kane is meant to take as data (a `--because`, an `--answer` with free text, a `--message`) is unsafe on a Windows command line unless the caller avoids the shim.
- **Holdback now:** never runs the shim. It reads the shim (or the package's `bin`) for `bin/kane-cli.cjs` and runs that with Node, with no shell; an argument with a NUL or a line break is refused (`packages/core/src/programs.ts`, `packages/core/test/programs.test.ts`, which drives a real shim of the same shape).
- **Suggestion:** take free text from a file or stdin (`--because-file`, `--because -`), and say in the Windows install notes that the shim re-parses its arguments.

## 13. Replays run side by side race Kane's own navigation to the start URL

- **Seen:** in the live rehearsal (`kane.parallel` 3; ledger `packages/core/test/fixtures/rehearsal/ledger.jsonl`), several replays failed at step 1 with an `automation_bug` verdict such as "Recorded start URL opens an unrelated KaneAI page", one of them saying "the objective still contains an unreplaced {{start_url}} value" (ledger line 81, m-ac-8-2). Kane's own session files tell a different story (`packages/core/test/fixtures/kane/rehearsal-start-navigation.json`, 47 sessions): `--override-start-url` was applied in every replay that had one (`override_applied: true`, and the replayed navigate went to the override URL), and the step-1 navigate failed with Playwright's `net::ERR_ABORTED` or "Navigation … is interrupted by another navigation" to that same URL. All 13 such failures happened while another Kane session was running; none of the 11 sessions that ran alone failed that way. The browser was still on `kaneai-playground.lambdatest.io`, which the verdict read as a wrong start URL. The closing replay of the real build hit it too: the step-1 navigate of t-3 and t-5 was aborted, the adaptive heal re-authored both, and they cost 22.33 and 28.82 credits (ledger lines 96 and 97).
- **What it means:** the variable is replaced and the override applied; Kane's own start navigation and the replayed first navigate overlap when several runs start at once, and the verdict then blames the recording. Holdback writes no file Kane reads during a replay (the variables file is written once, by the spec stage), so nothing on its side causes it.
- **Holdback now:** runs the falsify stage's replays one at a time (`breaker.parallel`, default 1), apart from `kane.parallel` for the build checks. Such a failure was already re-run once and never counted as a catch.
- **Suggestion:** wait for the initial navigation before replaying a recorded navigate to the same URL, and keep the verdict from calling a replaced variable unreplaced.

## 14. Kane's verdict family can be wrong, both ways

- **Seen:** in the live rehearsal (ledger `packages/core/test/fixtures/rehearsal/ledger.jsonl`):
  - m-ac-9-1 added a "?" to the SNAP checkbox's label, a real change to the page. Kane failed t-1 on it but called it `automation_bug` (locator rot: "the displayed page itself still shows the requested labels"), so it was not a catch (ledger line 29).
  - m-ac-8-2 dropped "($)" from the income label. t-3 failed with `application_issue`, "SNAP household incorrectly marked ineligible above monthly limit", on ac-1, ac-4 and ac-6 (line 82). Its screenshot (`~/.testmuai/kaneai/sessions/eee113c4-…/scratch/1/replay-test/screenshots/step_006.png`, on the machine that ran it) shows the form submitted before the SNAP box was ticked: a replay-ordering error, not the app. It named other criteria, so it did no harm here, but the same error on the attacked criterion would have counted as a catch.
  - In the same batch t-3, t-4 and t-5 passed ac-8, "a field labelled 'Monthly household income ($)'", on a page whose label had no "($)" (lines 82 to 84).
- **What it means:** one verdict is not enough to call a planted bug caught: an automation verdict can hide a real catch, and an application verdict can come from the replay itself.
- **Holdback now:** a planted bug counts as caught only when the failing replay's family is `application_issue` on the attacked criterion and a second replay of the same test, on the same planted bug started afresh, fails it again (`killsAc` and the second replay in `packages/core/src/loop/falsify.ts`). Disagreement is inconclusive: never a catch, never a miss. The second replay weeds out a flaky verdict, not a repeatable one: an error Kane makes again on a fresh start (m-ac-8-2's step order replays the same recording, so it would likely recur) still counts as a catch. A replay that fails is billed for Kane's verdict (2.9998 credits for the m-ac-7-1 catch, line 24), so the second replay of a catch costs about as much again.
- **Suggestion:** an exact-text mode for label assertions, and the step order in a verdict's evidence, so a caller can tell a replay that skipped a step.

Not filed upstream yet.
