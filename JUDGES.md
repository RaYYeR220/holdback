# Holdback for reviewers

Five minutes, no credentials. Each step says what to open and what it proves. Every figure here comes from a file in this repo; anything not recorded yet says pending.

<!-- headline:start -->Holdback planted a bug against each of the 26 criteria Kane's tests passed on a real app. Kane's replays could judge 10 of them and caught 4, each on two replays; none of the 6 that got past them broke the criterion it was planted against (3 changed no behaviour, 3 broke a different rule). On the held-out 22-case exam the builds tied: Holdback's build, Claude Code alone and Claude Code with its own Kane checks each passed 22/22.<!-- headline:end -->

## 1. The landing page and the demo video

<!-- links:start -->Landing page: pending · Demo video: pending · Dashboard replay: pending<!-- links:end -->

The landing page, the video and a hosted replay are not published yet. Until they are, steps 2 to 5 carry the evidence.

## 2. The dashboard replay of the pantry run

The replay is a static page that reads the pantry run's recorded ledger and rebuilds the run in your browser. It makes no API calls.

```sh
pnpm i
pnpm -r build                                      # builds the replay into apps/dashboard/dist-replay
pnpm --filter @holdback/dashboard preview:replay   # open the URL it prints
```

`pnpm --filter @holdback/dashboard build:replay` rebuilds only the replay once the packages are built. Look at:

- **The gate:** "Held back", 23 owed, 2/58 proved; the lede names the turn limit and the reached Kane credit cap.
- **Proved:** ac-29 and ac-32. ac-29's card carries the breaker's line (`<button type="submit" disabled>Book a visit</button>`), Kane's diagnosis "Book a visit does not open from eligible result", "Caught again" from the second replay, and the screenshot.
- **Vacuous:** ac-26, ac-27, ac-36 and ac-37, "Missed the bug". Read each card's planted line against the criterion above it: m-ac-36-1 adds `eligible: false` before a key the object sets again; m-ac-26-1 and m-ac-37-1 change only the branch for a household with a benefit; m-ac-27-1 only an income of 0. None of them breaks the criterion it was planted against.
- **Owed:** ac-53's card shows m-ac-53-1, whose removed and added lines are the same line. Kane evolved uc-2 on it.
- **Needs spec:** 22, among them 13 of uc-3 whose tests Kane's evolve retired (ac-12 and ac-21 still show the bug Kane caught before that).
- **The timeline:** the spec stage, then turns 1 to 9. Turn 9's segment holds the planted-bug pass (26 `Breaker planted` rows, each followed by Kane's replays), the evolves with what Kane minted and retired, and the two evolves that paused on Kane's own questions (Kane asked whether the breaker's account of a bug was right: it was not).
- **The exam board:** A, B and C at 22/22; C "did not claim done".

`apps/dashboard/test/parity.test.ts` checks that the replay's state equals what core reduces from the same ledger, and `e2e.test.ts` checks this page at 390, 1440 and 1920 pixels.

## 3. The recorded ledgers

<!-- demo:start -->
| Recorded demo run ([ledger](apps/dashboard/fixtures/ledger.jsonl)) | |
| --- | --- |
| Questions Kane asked about the spec | 2 |
| Acceptance criteria Kane designed | 57 |
| Browser tests Kane designed | 22 |
| Criteria left without a test (design cap) | 14 |
| Agent turns (Claude Code calls) | 9 |
| Kane bug reports that reached the agent | 7 |
| Criteria green after the first turn's check | 16 of 57 |
| Criteria green when the build stopped | 26 of 57 |
| Gate at the end | closed |
| Planted bugs Kane caught | 4 of 26 |
| Planted bugs that got past their criterion's tests | 6 (3 changed no behaviour, 3 broke a different rule) |
| Planted bugs whose replays proved nothing | 16 |
| Use cases Kane evolved after a surviving bug | 2 (1 more paused on Kane's own questions) |
| Tests Kane's evolves minted, retired | 5, 10 |
| Kane credits, by balance | 5233.9 |
| Agent cost | $6.37 |
| Claude Code minutes | 41.0 |
| Kane test-run minutes | 499.3 |
| Breaker cost | $0.0262 |
<!-- demo:end -->

- `apps/dashboard/fixtures/ledger.jsonl`: the pantry run's 331 ledger events, sanitized by `apps/dashboard/scripts/sanitize-ledger.mjs` (home paths, share links and evidence packs removed); `artifacts/`: the 19 screenshots it names; `config.json`: its config. [CLAIMS.md](CLAIMS.md#the-pantry-run) ties each figure to its event and line.
- `examples/first-live-run/`: the first live run (a 4-rule spec, 25 events, 3 screenshots). Kane asked 2 questions, designed 11 criteria and 3 tests, Claude Code built the app in one 72-second turn, and the breaker's 2 planted bugs were both caught ([CLAIMS.md](CLAIMS.md#the-first-live-run)).
- `packages/core/test/fixtures/rehearsal/ledger.jsonl`: the rehearsal on the same 4-rule spec, where the whole evolve loop ran: a planted bug ($2,461 became $2,460) got past t-1, Kane evolved the use case and covered what it left without a test, and the same bug, planted again, was caught by the new tests ([CLAIMS.md](CLAIMS.md#the-live-rehearsal)).

<details>
<summary>The 4-rule spec of the first live run and the rehearsal</summary>

The spec file is not in this repo; these are its screen and rules, as Kane's criteria quote them.

> The page "Food pantry eligibility check" has a field labelled "Household size", a field labelled "Monthly household income ($)", a checkbox labelled "Someone in the household receives SNAP", and a button "Check eligibility". The result appears below the button.
>
> 1. A household is eligible when its monthly income is at or below the monthly limit for its size.
> 2. Monthly limits (TEFAP, 185% of poverty, effective July 1, 2026): household of 1: $2,461; 2: $3,337; 3: $4,212; 4: $5,088; 5: $5,964; 6: $6,839; 7: $7,715; 8: $8,591. For each additional member above 8, add $876.
> 3. A household where someone receives SNAP is eligible regardless of income.
> 4. The result says "Eligible." or "Not eligible." and states the monthly limit that was applied.

</details>

To check a figure yourself: `holdback status --json` on a copy of the ledger, or the reducer in `packages/core/src/ledger/reduce.ts`. To replay the first live run in the dashboard: `VITE_REPLAY_DIR=../../examples/first-live-run pnpm --filter @holdback/dashboard build:replay`.

## 4. The pre-registered exam and its scores

[eval/PREREGISTERED.md](eval/PREREGISTERED.md) holds the held-out exam: 22 browser test files in `eval/exam/`, written from the regulation and `examples/pantry-spec/PRD.md`, with the expected outcome and the run rules. It lists the sha256 of every exam file, of `PRD.md` and `STACK.md`, and of the PRD lines the exam depends on. No build arm and no Holdback test-design step sees the exam.

- Check the hashes: `pnpm --filter @holdback/eval test`. `eval/prd.test.ts` re-hashes the 22 files against the table; `eval/reference.test.ts` ties each case's wording and expected result to the reference model in `eval/reference.ts`.
- Check the order: `git log --format="%h %ad %s" --date=iso -- eval/exam eval/PREREGISTERED.md eval/results` shows the exam committed before the results.
- The scores: `eval/results/summary.json`, and per arm `a.json`, `b.json`, `c.json` (each case's status, credits and duration), `a-run.json`, `b-run.json`, `c-run.json` (the build: turns, cost, minutes, whether it claimed done), `prd-final.json` (the registered spec hashes) and `today.json` (the pinned exam day, 2026-11-19).

<!-- exam:start -->On the held-out 22-case exam the builds tied: Holdback's build, Claude Code alone and Claude Code with its own Kane checks each passed 22/22.<!-- exam:end --> The tie means this spec is within reach of Claude Code alone. The pre-registered expectation was half met: Holdback scored at least as high as A and B, but A and B did not stop with a failing case. The [README](README.md#the-exam) has the table, the costs and what C's 2,268.2 wall minutes cover.

## 5. A planted bug Kane caught, and its report

From the pantry run (`mutant` m-ac-29-1 and the `run` events after it, lines 254 to 258 of `apps/dashboard/fixtures/ledger.jsonl`). The agent's app had passed ac-29:

> ac-29: A result of 'Eligible.' offers a 'Book a visit' button that opens booking for that household.
> Spec: "Every "Eligible." result also has a "Book a visit" button that opens the Book a visit page for that household; other results have no such button." (L65)

The breaker (deepseek-v4-flash on the Venice API) planted this in a throwaway worktree, for $0.0009:

```diff
-      after += `<form method="get" action="/book-a-visit"><input type="hidden" name="check" value="${esc(outcome.checkId)}"><button type="submit">Book a visit</button></form>`;
+      after += `<form method="get" action="/book-a-visit"><input type="hidden" name="check" value="${esc(outcome.checkId)}"><button type="submit" disabled>Book a visit</button></form>`;
```

Kane replayed ac-29's tests against it with healing off. t-9 failed at step 3 with `application_issue`, "Book a visit action does not open the booking page", and failed again on a second replay of the same planted bug started afresh: "Book a visit does not open from eligible result". The bug was killed and ac-29 became proved. Screenshot: `apps/dashboard/fixtures/artifacts/m-ac-29-1-step_001.png`.

In a build turn, the same fields reach the agent as its bug report. This is the brief section that `buildBrief` (`packages/core/src/loop/brief.ts`) renders from the first live run's caught bug (`examples/first-live-run/ledger.jsonl`); it was not sent, because the bug lived in a throwaway worktree:

```text
## ac-2 — For a household without SNAP whose monthly income exceeds its applicable monthly limit, the result says “Not eligible.”
Spec: "A household is eligible when its monthly income is at or below the monthly limit for its size." (prd L10-L12)
Kane ran: On the Food pantry eligibility check page, enter household size 1 and monthly household income $2,462, leave Someone in the household receives SNAP unchecked and check eligibility, then assert the result below the Check eligibility button says “Not eligible.” and states an applied monthly limit of $2,461.
Kane saw: Eligible. Monthly limit applied: $2,461.
Kane's diagnosis: Eligibility checker approves income above displayed monthly limit — The eligibility decision is treating an income that exceeds the stated monthly limit as eligible.
Suggested: Fix the income comparison so a one-person household with no SNAP and monthly income of $2,462 is not eligible when the applied limit is $2,461.
Screenshot: kane-evidence/turn-1/t-1-step-2.png
```

The agent sees the criterion, the spec, what Kane did and saw, and Kane's diagnosis. It never sees the test file. In the pantry run, the briefs of turns 2 to 9 carried 7 such reports from real build checks.

When a planted bug gets past every test of its criterion, Holdback asks Kane to evolve the use case, telling it what slipped through:

```text
kane-cli maintain evolve uc-2 --because "A planted bug got past every test of this use case. ac-53 (…): The volunteer list displays visits from all dates, not just today, … Add a test that catches it." --mode agent
```

Kane minted t-23 and retired t-17, then, asked once more to cover four criteria, minted t-24 to t-26 (`falsify.evolved`, lines 311 and 312). That reason was the breaker's account of m-ac-53-1, a patch that changed nothing: Holdback then took the breaker at its word. It now sets such a patch aside before any replay, and a survivor reaches Kane only once a referee confirms it ([CLAIMS.md](CLAIMS.md#what-the-demo-run-showed)). `holdback status` never shows the reason, since the coding agent may run it; `holdback run`, `holdback watch` and the dashboard show you what Kane was told.

## 6. Run it yourself

You need Node 24, pnpm 9, git, Kane CLI 0.10.4 or later (logged in, with credits), and Claude Code. `VENICE_API_KEY` is optional; without it, run `holdback run --no-falsify`. The [README](README.md#quick-start) has the install.

```sh
holdback init    # in your app's folder: a git repository with PRD.md
holdback spec    # answer Kane's questions, approve its criteria, fill the test variables it left empty
holdback run     # build, check, falsify
```

What Kane cost, from the ledgers:

| Step | Kane credits | Time |
| --- | --- | --- |
| `holdback spec` on the 4-rule spec (first live run): resume after 2 answers, then design 11 criteria and 3 tests | 1.40 + 22.55 | 97 s from ingest to seal |
| `holdback spec` on the pantry spec: 2 questions, then 57 criteria and 22 tests | 98.4 by balance | 81.0 minutes, the human's review included |
| Authoring a test on its first run (first live run: t-1 and t-2, 4 steps each) | 65.31 and 63.20, about 16 per step | 32 to 48 s per step |
| The pantry run's build checks after 8 of its 9 turns (138 test runs) | 4,724.6 by balance | |
| Replaying a test that passes (first live run: t-2, turn 2) | 0 | 27 s |
| Replaying a test that needed a heal (first live run: t-1, turn 2) | 17.58 | 135 s |
| The pantry run's planted-bug pass: 26 planted bugs, 36 replays, then 10 closing replays | 337.4 by balance | 70.4 minutes of test runs |
| Kane's evolves in the pantry run (3 that minted tests, 2 that failed) | 73.5 by balance | |
| The breaker, per planted bug (USD, not credits) | $0.0009 to $0.0019 in the pantry run (more when a patch did not apply and was asked again) | |

A test that fails is authored again on every run, at the authoring rate. Holdback logs the balance before and after every Kane batch. See [FINDINGS.md](FINDINGS.md).

## 7. The hackathon's published criteria → where to look

| Criterion | What to look at | Evidence |
| --- | --- | --- |
| Ships | Install from source, then `init`, `spec`, `run`; a dashboard (live and replay) and a landing page; all three ran end to end on the pantry spec | [README.md](README.md#quick-start), `packages/cli/src/index.ts`, `apps/dashboard/`, `apps/site/`; `pnpm -r build`, `pnpm -r test`; step 2 |
| Verified | Kane designed 57 cited criteria and 22 tests from the pantry spec, ran them in a real browser, and caught all 4 planted bugs it judged that broke their criterion, each twice; the survivors and the runs that proved nothing are on the record with their reasons. The exam score: <!-- exam-status:start -->VERIFIED-LIVE<!-- exam-status:end --> | `apps/dashboard/fixtures/ledger.jsonl` (`design`, `run`, `mutant` events), steps 2, 3 and 5, [CLAIMS.md](CLAIMS.md#the-pantry-run), `eval/results/` |
| Closed loop | Live in the pantry run: Kane's bug reports in the agent's briefs, the agent's commits, Kane's checks, the gate held shut, planted bugs replayed, and Kane evolving its tests inside `holdback run` with the new tests sealed. Live in the rehearsal: a survivor caught by Kane's new tests. Built and unit-tested: drift, bisect, the stall stop and the interactive hooks. The recorded demo run: <!-- demo-status:start -->VERIFIED-LIVE<!-- demo-status:end --> | the ledger's `turn.start`, `turn.end`, `run`, `mutant` and `falsify.evolved` events; `packages/core/src/loop/build.ts`, `brief.ts`, `falsify.ts`; `packages/cli/src/hooks.ts`; `packages/core/test/build.test.ts`, `falsify.test.ts`, `packages/cli/test/hooks.test.ts` |
| Craft | A gate that fails closed on tamper and on runs that prove nothing, Kane's verdict family respected and a catch counted only when a second replay agrees, spend read from the balance, one verdict for `holdback run`, `status` and the dashboard, a replay that matches core, and findings on Kane CLI from three live runs, Holdback's own breaker included | `packages/core/src/seal.ts`, `tamper.ts`, `kane/outcome.ts`, `ledger/credits.ts`, `ledger/verdict.ts`, `loop/falsify.ts`; `apps/dashboard/test/parity.test.ts`; [FINDINGS.md](FINDINGS.md), [MOCKS.md](MOCKS.md) |
