# Holdback for reviewers

Five minutes, no credentials. Each step says what to open and what it proves. Every figure here comes from a file in this repo; anything not recorded yet says pending.

<!-- headline:start -->Exam pending: Holdback's build and Claude Code alone have not been scored yet on the held-out 22-case exam ([pre-registration](eval/PREREGISTERED.md)).<!-- headline:end -->

## 1. The landing page and the demo video

<!-- links:start -->Landing page: pending · Demo video: pending · Dashboard replay: pending<!-- links:end -->

The landing page and the video are not published yet. Until they are, steps 2 to 5 carry the evidence.

## 2. The dashboard replay of the recorded run

The replay is a static page that reads a recorded ledger and rebuilds the run in your browser. It makes no API calls. Its link is in step 1 once it is published. To build it yourself:

```sh
pnpm i
pnpm -r build
pnpm --filter @holdback/dashboard preview:replay   # open the URL it prints
```

Until the demo run is recorded, the replay shows the first live run (`apps/dashboard/fixtures/`). Look at:

- the gate: held back, with 5 criteria owed and 2 of 11 proved;
- the board: each criterion with the spec line Kane cited and Kane's latest observation;
- ac-2 and ac-3 in Proved: the planted line and the run that caught it;
- the timeline: the spec stage, turn 1 (the agent's commit, then Kane's three runs) and turn 2.

`apps/dashboard/test/parity.test.ts` checks that the replay's state equals what `holdback serve` reports for the same ledger.

## 3. The recorded ledger and screenshots

<!-- demo:start -->
Demo run pending: nothing from it is claimed yet.
<!-- demo:end -->

The demo run's ledger and Kane's screenshots will be in `examples/recorded-run/`. The first live run is already in the repo:

- `apps/dashboard/fixtures/ledger.jsonl`: its 25 ledger events, sanitized by `apps/dashboard/scripts/sanitize-ledger.mjs` (home paths, share links and evidence packs removed);
- `apps/dashboard/fixtures/artifacts/`: the 3 screenshots the ledger names;
- `apps/dashboard/fixtures/config.json`: the run's config.

What the ledger shows: Kane asked 2 questions about a 4-rule spec and designed 11 criteria and 3 tests. Claude Code built the app in one 72-second turn. Kane passed 2 of the 3 tests on the first check; the third timed out partway through authoring its 11 steps. Then 2 planted bugs were both caught. [CLAIMS.md](CLAIMS.md) ties each of these to the event that records it.

<details>
<summary>The 4-rule spec of the first live run</summary>

The spec file is not in this repo; these are its screen and rules, as Kane's criteria quote them.

> The page "Food pantry eligibility check" has a field labelled "Household size", a field labelled "Monthly household income ($)", a checkbox labelled "Someone in the household receives SNAP", and a button "Check eligibility". The result appears below the button.
>
> 1. A household is eligible when its monthly income is at or below the monthly limit for its size.
> 2. Monthly limits (TEFAP, 185% of poverty, effective July 1, 2026): household of 1: $2,461; 2: $3,337; 3: $4,212; 4: $5,088; 5: $5,964; 6: $6,839; 7: $7,715; 8: $8,591. For each additional member above 8, add $876.
> 3. A household where someone receives SNAP is eligible regardless of income.
> 4. The result says "Eligible." or "Not eligible." and states the monthly limit that was applied.

</details>

## 4. The pre-registered exam

[eval/PREREGISTERED.md](eval/PREREGISTERED.md) holds the held-out exam: 22 browser test files in `eval/exam/`, written from the regulation and `examples/pantry-spec/PRD.md`, with the expected outcome and the run rules. It lists the sha256 of every exam file, of `PRD.md` and `STACK.md`, and of the PRD lines the exam depends on. No build arm and no Holdback test-design step sees the exam.

- Check the hashes: `pnpm --filter @holdback/eval test`. `eval/prd.test.ts` re-hashes the 22 files against the table; `eval/reference.test.ts` ties each case's wording and expected result to the reference model in `eval/reference.ts`.
- Check the order: `git log --format="%h %ad %s" --date=iso -- eval/exam eval/PREREGISTERED.md` shows when the exam was committed.
- The result, once scored, is the headline above and the results table in [README.md](README.md#results), both rendered from `eval/results/summary.json`.

## 5. A planted bug Kane caught

From the first live run (`mutant` and `run` events with `"kind":"falsify"` in `apps/dashboard/fixtures/ledger.jsonl`). The agent's app had passed criterion ac-2:

> ac-2: For a household without SNAP whose monthly income exceeds its applicable monthly limit, the result says "Not eligible."
> Spec: "A household is eligible when its monthly income is at or below the monthly limit for its size." (L10-L12)

The breaker (deepseek-v4-flash on the Venice API) planted this in a throwaway worktree, for $0.000345:

```diff
-      const eligible = snap || (Number.isFinite(income) && income <= limit);
+      const eligible = snap || (Number.isFinite(income) && income >= limit);
```

Kane replayed the sealed test t-1 against it with healing off. It failed at step 2 and Kane reported:

> **Eligibility checker approves income above displayed monthly limit**
> Saw: "Eligible. Monthly limit applied: $2,461."
> Root cause: The eligibility decision is treating an income that exceeds the stated monthly limit as eligible.
> Suggestion: Fix the income comparison so a one-person household with no SNAP and monthly income of $2,462 is not eligible when the applied limit is $2,461.

The bug was killed, and ac-2 became proved. The second planted bug dropped `snap ||` from the same line. Kane caught it with t-2 ("SNAP household incorrectly marked ineligible above displayed income limit"), and ac-3 became proved. Screenshots: `apps/dashboard/fixtures/artifacts/m-ac-2-1-step_007.png` and `m-ac-3-1-step_009.png`.

In a build turn, the same fields reach the agent as its bug report. This is ac-2's section of the brief that `buildBrief` (`packages/core/src/loop/brief.ts`) renders from that verdict. It was not sent, because the bug lived in a throwaway worktree:

```text
## ac-2 — For a household without SNAP whose monthly income exceeds its applicable monthly limit, the result says “Not eligible.”
Spec: "A household is eligible when its monthly income is at or below the monthly limit for its size." (prd L10-L12)
Kane ran: On the Food pantry eligibility check page, enter household size 1 and monthly household income $2,462, leave Someone in the household receives SNAP unchecked and check eligibility, then assert the result below the Check eligibility button says “Not eligible.” and states an applied monthly limit of $2,461.
Kane saw: Eligible. Monthly limit applied: $2,461.
Kane's diagnosis: Eligibility checker approves income above displayed monthly limit — The eligibility decision is treating an income that exceeds the stated monthly limit as eligible.
Suggested: Fix the income comparison so a one-person household with no SNAP and monthly income of $2,462 is not eligible when the applied limit is $2,461.
Screenshot: kane-evidence/turn-1/t-1-step-2.png
```

The agent sees the criterion, the spec, what Kane did and saw, and Kane's diagnosis. It never sees the test file.

When Kane misses a planted bug, the criterion is vacuous and Holdback asks Kane to evolve its use case, telling it what slipped through. Captured live on a copy of the pantry verifier (`packages/core/test/fixtures/kane/14-evolve-paused.ndjson`, `15-evolve-complete.ndjson`):

```text
kane-cli maintain evolve uc-1 --because "A version of the app where household size 9 is checked against the 8-person limit passed every test. ... household of 9, income 9000 (between 8591 and 9467), no SNAP, must be Eligible with limit 9467." --mode agent
```

Kane paused on its own re-design question, which Holdback answers with `--answer evolve:uc-1=1`, then minted t-4: "Nine-person household earning $9,000 uses the $9,467 limit". Its new set replaced all three old tests of the use case and left three criteria without a test; Holdback asks once more for those, seals the new tests with Kane as their author, owes every criterion of the use case again, and plants the same bug once the new tests pass: it must now be caught. The coding agent never sees the reason: `holdback status` shows only how many tests each evolve minted and retired, while `holdback run` and the dashboard show you what Kane was told. [FINDINGS.md](FINDINGS.md) finding 11 has the details; the evolve inside `holdback run` is built and unit-tested, not run live yet.

## 6. Run it yourself

You need Node 24, pnpm 9, git, Kane CLI 0.10.4 or later (logged in, with credits), and Claude Code. `VENICE_API_KEY` is optional; without it, run `holdback run --no-falsify`. The [README](README.md#quick-start) has the install.

```sh
holdback init    # in your app's folder: a git repository with PRD.md
holdback spec    # answer Kane's questions and approve its criteria
holdback run     # build, check, falsify
```

What Kane cost in the first live run, from the per-run figures in its ledger:

| Step | Kane credits | Time |
| --- | --- | --- |
| `holdback spec` on the 4-rule spec: resume after 2 answers, then design 11 criteria and 3 tests | 1.40 + 22.55 | 97 s from ingest to seal |
| Authoring a test on its first run (t-1 and t-2, 4 steps each) | 65.31 and 63.20, about 16 per step | 32 to 48 s per step |
| Replaying a test that passes (t-2, turn 2) | 0 | 27 s |
| Replaying a test that needed a heal (t-1, turn 2) | 17.58 | 135 s |
| Replaying a planted bug, healing off | 2.62 and 2.76 | 58 s and 47 s |
| The breaker, per planted bug (USD, not credits) | $0.000345 and $0.00045 | |

A test that fails is authored again on every run, at the authoring rate. The ingest's own credits are missing from the spec-stage figure: that version of Holdback did not log a paused call's credits. It does now, and it also logs the balance before and after every Kane batch. See [FINDINGS.md](FINDINGS.md).

## 7. The hackathon's published criteria → where to look

Each published criterion, and the files in this repo that bear on it.

| Criterion | What to look at | Evidence |
| --- | --- | --- |
| Ships | Install from source, then `init`, `spec`, `run`; a dashboard and a landing page | [README.md](README.md#quick-start), `packages/cli/src/index.ts`, `apps/dashboard/`, `apps/site/`; `pnpm -r build` and `pnpm -r test` |
| Verified | Kane designed 11 cited criteria and 3 tests from the spec, ran them in a real browser, and caught 2 of 2 planted bugs with its own diagnosis. The exam score: <!-- exam-status:start -->NOT-CLAIMED (pending)<!-- exam-status:end --> | `apps/dashboard/fixtures/ledger.jsonl` (`design`, `run`, `mutant` events), step 5 above, [eval/PREREGISTERED.md](eval/PREREGISTERED.md), [CLAIMS.md](CLAIMS.md) |
| Closed loop | Live: the owed brief went to Claude Code, it built, Kane checked the build and the ledger kept the gate shut. Built and unit-tested: Kane's bug report going back to the agent, the interactive hooks that wake it after an edit and refuse its stop. The recorded demo run: <!-- demo-status:start -->NOT-CLAIMED (pending)<!-- demo-status:end --> | the ledger's `turn.start`, `turn.end` and `run` events; `packages/core/src/loop/build.ts`, `brief.ts`; `packages/cli/src/hooks.ts`; `packages/core/test/build.test.ts`, `packages/cli/test/hooks.test.ts` |
| Craft | A gate that fails closed on tamper and on runs that prove nothing, Kane's verdict family respected, spend read from the balance, a replay that matches the live server | `packages/core/src/seal.ts`, `tamper.ts`, `kane/outcome.ts`, `ledger/credits.ts`; `apps/dashboard/test/parity.test.ts`; [FINDINGS.md](FINDINGS.md), [MOCKS.md](MOCKS.md) |
