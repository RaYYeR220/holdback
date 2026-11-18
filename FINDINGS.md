# Kane CLI findings

What Holdback found about Kane CLI 0.10.4. Each finding has its evidence in this repo, what Holdback does about it, and a suggestion. Findings 1 to 14 come from the first live run and the rehearsal on a 4-rule spec; there, "the ledger" is the first live run's, `examples/first-live-run/ledger.jsonl`. Findings 15 to 22 come from the pantry run (2026-11-16 to 18), whose ledger is `apps/dashboard/fixtures/ledger.jsonl` (line numbers are its lines); 22 comes from a later pass, its evidence in a fixture of its own.

## 1. `--timeout` bounds each step, not the whole run

- **Seen:** t-3 has 11 steps and ran with `--timeout 420` (`kane.timeoutS` in `examples/first-live-run/config.json`). Its steps took 36 to 49 seconds each. At 450.9 seconds Kane was still running, and Holdback's own whole-run timer stopped it after 9 passed steps (the ledger's turn-1 `run` for t-3). The run billed 164.87 credits and saved nothing.
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
- **What it means:** the gap's content is an object. Kane keeps it in its own store, in the commit that minted the gap and in `.context/derived/nodes/<2>/<rest of the cid>.json`: `kind` (`budget-evicted`, `incomplete`, `invariant-unexercised`), the use case's cid, and `question: {header, prompt, options}`, its options as `{label, detail}` objects in one run and as plain strings in another (`packages/core/test/fixtures/kane/context-commits/`).
- **Holdback now:** reads each gap's kind and question from Kane's store, keeps a design's gaps to its own use case, prints them after `holdback spec` and shows them on the dashboard; a gap the store says nothing about keeps its id (the first live run's `design` event: gap-1 to gap-3) (`packages/core/src/kane/assurance.ts`, `packages/core/test/assurance.test.ts`).
- **Suggestion:** render the gap's header and question as its title, and document the gap kinds.

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

- **Seen:** Holdback passes `kane.designMax` as `kane-cli design tests --max`, which caps the scenarios Kane designs per use case, one test each (`packages/core/src/kane/assurance.ts`). With `--max 3` (`examples/first-live-run/config.json`), Kane designed 3 tests of 4, 4 and 11 steps. The 11-step test is the one that timed out (finding 1).
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

## 15. Variables `design tests` leaves empty are sealed and run as they are, unless the caller fills them

- **Seen:** in the pantry run's spec stage (2026-11-16), `design tests` declared 12 owner-supplied variables in `.testmuai/variables/assurance.json` with an empty `value` and a description of what goes there: `primary_phone` ("Unused ten-digit household test phone, supplied as digits only"), `primary_phone_formatted` ("Same ten digits as primary_phone with permitted punctuation in a different format"), `proxy_name`, `slot_phone_1` to `slot_phone_7` ("Distinct unused ten-digit phone for full-slot household N"), `invalid_phone` ("Test phone input consisting of exactly nine digits") and `spare_phone` (`packages/core/test/fixtures/kane/variables-declared-empty.json`, as Kane wrote it; Holdback had filled `start_url`). Its `incomplete` gaps said the same: "Leave {{slot_phone_1}} through {{slot_phone_7}} for the owner to fill". Nothing stopped a caller from sealing and running the tests as they were: Holdback filled only `start_url`, and 11 of the 22 tests failed with an `automation_bug` verdict, typing empty values. The human then filled the file by hand.
- **What it means:** a design is not runnable until someone fills its variables, and neither `design tests` nor `testmd run` says so; the run fails as Kane's own automation, so a loop records it as inconclusive, never as the app's failure, and pays for it on every turn.
- **Holdback now:** never seals a test that types an empty variable. In `holdback spec` and `holdback drift` it asks the human for each, with a test value it derives from the description (a distinct `215555` number for each phone, the same digits punctuated for a "formatted" one, nine digits for "nine digits", a test name for a person's name); a secret is asked for with no suggestion. After Kane's evolve it writes those suggestions itself, or, for a secret or a variable it has no suggestion for, does not seal the evolve (`packages/core/src/loop/variables.ts`, `spec.ts`, `drift.ts`, `falsify.ts`; `packages/core/test/variables.test.ts`, `spec.test.ts`, `drift.test.ts`, `falsify.test.ts`).
- **Suggestion:** fail `testmd run` before it starts when a variable a test uses is empty, and let `design tests` propose fixture values (or say in its summary which variables the owner must fill).

## 16. On Windows an `@import` can be written as an absolute path after `./`

- **Seen:** in the pantry run's spec stage, Kane 0.10.4 on Windows designed a test that imports another as `@import ./C:\Users\…\verifier\.testmuai\tests\book-an-available-visit-and-confirm-proxy-and-schedule_test.md`: the absolute path of the imported test joined after `./` (`packages/core/test/fixtures/kane/import-absolute-windows_test.md`, its home path renamed). `testmd run` stopped on it with "@import path not found". The human changed the line to `@import ./book-an-available-visit-and-confirm-proxy-and-schedule_test.md`, the file next to it.
- **What it means:** a test that imports another may never run on Windows, whatever the app does.
- **Holdback now:** in `holdback spec`, before the human approves the tests, records (`spec.repaired`) and then rewrites such an import to the file of that name in the tests folder, and shows it on the test in the approval; one it cannot repair that way, and any import that resolves to no file, is flagged there (`packages/core/src/loop/imports.ts`, `packages/core/test/variables.test.ts`).
- **Suggestion:** write imports relative to the test's folder (`path.relative`, with `/`), and check that each import resolves when the design is committed.

## 17. A step that does several things outruns a per-step timeout

- **Seen:** the pantry run used `--timeout 120` (`kane.timeoutS` in `apps/dashboard/fixtures/config.json`). 9 runs were stopped at Holdback's whole-run bound (the timeout times the test's steps, plus 30 seconds) before Kane finished: 7 of turn 4's runs and t-19 in turns 6 and 7 (lines 77, 78, 81, 82, 85, 87, 91, 125, 152). Kane's verdicts on their first attempts named the cause, such as "Step budget cannot complete six required visit bookings" (t-3, line 78) and "Selected visit variables captured in incompatible format" (t-2, line 77: 108.95 credits over 560 seconds).
- **What it means:** a test whose one step books six visits does not fit a budget sized for one action, and the run ends as a timeout, which proves nothing, after it has spent its credits.
- **Holdback now:** re-runs such a run once, then counts it inconclusive and never briefs it.
- **Suggestion:** report which step ran out of time and how long it had run, and let a design split a step that repeats an action, or carry a per-step budget in the test file.

## 18. Tests depend on rows that other tests leave behind

- **Seen:** Holdback starts the app once per batch, with an empty data folder, and Kane runs the batch's tests one after another against it. At the end of the build, 6 of the 7 tests still failing had an `automation_bug` verdict about such data: t-3 "Required visit slot lacks capacity for sixth booking" (the 10:00 slot was already full from earlier tests), t-16 "Expected-today fixture contains extra visits", t-18 "Prepared expected-visit fixtures do not match the volunteer list", t-21 "Automation picked up every remaining expected visit", t-22 "Prepared volunteer roster was not loaded" and t-6 "Booking-page state assumed but unavailable" (lines 179 to 191). Replayed alone against a planted bug, t-13 and t-20 found the opposite: "Expected-today visit fixture is missing" and "Prepared volunteer visit is absent from live test data" (`mutant` m-ac-47-1 and m-ac-61-1, lines 290 and 299).
- **What it means:** the tests assume rows that only some earlier test, in some order, creates: after other tests they meet too much data, alone too little. No order makes them all pass, whatever the app does.
- **Holdback now:** counts each such run inconclusive, never a catch and never briefed; the gate stays shut while they keep failing. In the pantry run they held 17 criteria owed.
- **Suggestion:** let a test declare the data it needs (a setup step, or an imported fixture flow that runs first), and say in the `design tests` output when a test relies on another test's side effects.

## 19. A replay with healing off can select an input after it submits the form

- **Seen:** 5 planted-bug replays of t-1 and t-2, with `--no-adaptive-heal`, ended in `automation_bug` with Kane's own diagnosis of its recording: "Visit-time selection recorded after booking submission", "Visit-time selection replayed after booking", "Replay selects visit time after booking confirmation" (`mutant` m-ac-7-1, m-ac-10-1, m-ac-11-1, m-ac-13-1, m-ac-18-1, lines 196 to 217). The same tests passed in build checks, where healing is on.
- **What it means:** the recording replays its steps in an order that cannot work, and only a heal saves it. Every planted bug judged by these two tests proved nothing: 5 of the 16 that did.
- **Holdback now:** replays planted bugs with healing off, so that the sealed test is what judges them, and counts such a replay inconclusive.
- **Suggestion:** check a recording's action order when the test is authored (a form's select before its submit), or have a replay with healing off name the recorded step that is out of order.

## 20. Kane's evolve checks the reason it is given against the spec, and pauses when the two disagree

- **Seen:** twice in the pantry run, `maintain evolve` started a child `design tests` session (`evolve_target`, `child_start`) that paused on its own questions (`session_paused`), and the evolve ended `done` with `status: "paused"`, exit 3, pointing at `design tests --resume <sid> --answer q1=1` (`redesign.dropped`, lines 305 and 315). For uc-1, Kane asked: "For a household of one with no benefit and $568 weekly income, should the result be Eligible. as the published at-or-below rule says, or Not eligible. as the bug report says?" The bug report was the breaker's account of m-ac-27-1, and it was wrong; Kane also said the reason was cut off. For uc-3's follow-up it asked what "an unfinished 'ac'" meant. Holdback then cut the reason at 1,500 characters, mid-sentence.
- **What it means:** Kane's pause was right. Its design agent read the reason against the spec, found the planted bug's claim contradicts the published rule, and asked instead of writing a test for the wrong behaviour; the planted bug itself (an income of 0 treated like a benefit) never breaks ac-27. It also noticed that the reason had been cut. The fault was upstream: Holdback took the breaker's account at its word and cut its own message. An evolve can also stop at two levels, with two resume commands, so a caller that knows only the evolve's own question sees a failure.
- **Holdback now:** a planted bug reaches Kane only after a no-op filter and a referee that must name an input where it visibly breaks its criterion (m-ac-27-1's would have to survive that), and Kane is told the referee's account. A pause on a question of Kane's, on the evolve or in its design session, is Kane disputing the bug: Holdback never answers it, records `falsify.disputed` with Kane's question, retires and seals nothing, and counts the bug as invalid, its criterion back at the status it had. Only the evolve's own re-design gate (`--answer evolve:<uc>=1`) is answered. The reason is never cut: it carries fewer whole accounts and says how many it left out, and one too long for Kane's command line is not sent at all.
- **Suggestion:** surface the child session's questions on the evolve itself, answerable with `maintain evolve --answer`, and take a long reason from a file or stdin.

## 21. An application verdict that its own observation contradicts

- **Seen:** in turn 3, t-15 failed with `application_issue` (confidence 0.9, `navigation_defect`): "Volunteer list link does not display the Volunteer list", root cause "The app received the Volunteer list page request but did not switch the displayed page" (line 57). The same verdict's `observed` reads "Expected today lists 0111–0115; 0101 is Picked up and 0199 is absent.", which is the volunteer list. The app's link was a plain `<a href="/volunteer">Volunteer list</a>`. Variants followed in turns 5 to 9 ("Volunteer list link returns users to eligibility check", "Volunteer list link does not leave eligibility check", lines 103, 121, 166, 184); the agent moved the link to `/volunteer-list` in turn 6, and the final app passed the exam's volunteer-list cases (`eval/results/c.json`, e-17 and e-18).
- **What it means:** an application verdict goes to the coding agent as a bug to fix. When it is wrong, the agent spends turns on a link that works, and the criterion never passes.
- **Holdback now:** briefs it, as Kane blamed the app. When two turns in a row change nothing, the stall stop lists such reports as disputed for a human to review (R48).
- **Suggestion:** check a verdict's root cause against its own `observed` before blaming the app, and add the page URL at the failing step to the evidence.

## 22. Some criteria Kane writes hang off a scenario, not the use case, and an evolve's new test verifies them

- **Seen:** in its first design of uc-1, Kane wrote ac-39 ("The out-of-area result includes 'We serve ZIP codes 19104, 19139 and 19143 only.'") with a `scoped_to` edge to scenario sc-7 and none to uc-1; ac-40 to ac-44 are the same, under other scenarios. The design's criteria for uc-1 are ac-24 to ac-38, yet the sealed t-7, t-8 and t-9 verify ac-39 to ac-44 as well. On 2026-11-18, after the pass's survivors, `maintain evolve uc-1` (25.98 credits) wrote two new tests and kept the 6 it had ("⚒ wrote deny-unserved-zip-20001-without-a-checked-benefit_test.md · apply-two-published-annual-increments-for-ten-household_test.md", `keptTests` 6); the first verifies ac-24, ac-39 and ac-28. Neither file had ever been sealed (`packages/core/test/fixtures/kane/22-evolve-scenario-criterion.json`: Kane's store, its design log of that evolve and the ledger's last seal). Kane's own report of an evolve (`evolve_diff` on stdout) is not kept anywhere: not in the ledger, not in Kane's logs.
- **What it means:** an evolve's new test can verify a criterion that, read from Kane's graph, belongs to no use case. Kane did not edit a sealed test in place.
- **Holdback then:** refused the new test, because a minted test may verify only criteria of the use case it evolves, and logged it as a sealed file Kane "did not mint or retire" (`falsify.evolve.stray`): a tamper, the evolve rolled back.
- **Holdback now:** a new test may also verify a criterion the ledger has under no use case when a sealed test of the same use case already verifies it and Kane's graph puts it under no other use case. A refused new test is named as one, with the reason: "minted tests Holdback may not seal: <path> (t-N: it verifies ac-9, not a criterion of uc-1)".
- **Suggestion:** give such a criterion a `scoped_to` edge to its scenario's use case as well, so `context view` says where it belongs.

Not filed upstream yet.
