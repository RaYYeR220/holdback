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

Not filed upstream yet.
