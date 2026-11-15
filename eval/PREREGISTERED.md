# Pre-registered exam

The exam in `eval/exam/` measures how much of the pantry spec a finished app really does, on cases where a plausible misreading of `examples/pantry-spec/PRD.md` gives a different answer:

- income exactly at the limit and $1 above it, for weekly, monthly, yearly and every-two-weeks income;
- households of more than 8 people;
- limits that only match when the published column is used;
- benefits that make a household eligible regardless of income;
- ZIP codes outside the service area, including when a benefit is ticked;
- one visit per household per calendar month;
- a visit time that is full, and one that still has room for a sixth household;
- the proxy shown on the volunteer list;
- marking a pickup.

Each case is one `_test.md` file run in a real browser, and its single decisive check is in its last step. `eval/reference.ts` computes the expected result of every case from the Pennsylvania TEFAP table (effective July 1, 2026 to June 30, 2027) and the PRD, and `eval/reference.test.ts` ties each file's wording and expected result to that reference. The exam was written from the regulation and the PRD, then committed with the hashes below before any build arm or Holdback run. No build arm and no Holdback test-design step sees it.

## Expectation

Holdback (C) scores ≥ the agent alone (A) and ≥ the agent with self-written Kane checks (B) on this exam; A and B each stop claiming done with at least one exam case failing.

## How it is run

- Every arm (A, B, C) builds from the same final `PRD.md` and `STACK.md` and runs without web access. Before the first arm runs, the final `PRD.md` (with Kane's clarifying questions and answers appended) is hashed into `eval/results/`.
- Each arm's final app is scored once, as a fresh app on a fresh, empty `DATA_DIR`, with:
  - `HOLDBACK_TODAY` = `nextExamToday()`: a Tuesday, Thursday or Saturday on or after the 7th of its month. The value is computed once, from the first scoring date, and the same value is used for all three arms. It is stored in `eval/results/` when it is first computed.
  - `HOLDBACK_NOW` = `08:00`.

  These settings make the earliest visit time listed today's 10:00, keep every one of today's visit times open whatever the wall clock says, and put visit times of the next calendar month inside the 28-day booking window.
- The `start_url` variable is the app's base URL.
- Each file runs with `kane-cli testmd run`, one attempt per case, in any order. There are no reruns. The booking cases use their own phone numbers and do not depend on each other.
- A case passes when its run passes. The score is passed cases out of 22.
- The exam id is the `tags` entry `e-NN`; Kane's frontmatter accepts `tags`, not custom keys.
- The repository is pushed only after scoring. Commit times and the hashes below show that the exam came first.

## Spec at registration

Later PRD changes are append-only. New rules go after the last numbered rule, and Kane's questions and their answers go in a "Clarifications" section. Existing rule numbers and copy never change.

The exam depends on these parts of the PRD:

- PRD rules 1–3, 5–12, 14–29, 32–33, 36, 38, 40–51, 53–60;
- the income limits table;
- the Messages row "This household already has a visit booked in that month."

`examPrdLines()` in `eval/reference.ts` extracts exactly those lines, and the test suite checks their hash below against the current PRD. The extraction stops at a "Clarifications" heading and at any heading after the Messages section. An edit to any of these lines fails the check; appended text must not contradict them. The PRD.md and STACK.md hashes are for the files as registered here, and the test suite also checks the STACK.md hash.

| File | sha256 |
| --- | --- |
| `examples/pantry-spec/PRD.md` | `103b624223aa856f1dfb14663febeb4afd842fc4d76ee073bf1feacc528308d1` |
| `examples/pantry-spec/STACK.md` | `bfa02f18cfe7a65a234226eff725f3d88acaa005b80ef124220aef1267cc191b` |
| PRD lines the exam depends on (`examPrdLines()`) | `cf71451e27c5cebebdead56688f96a467f6dcc412404f01666a57c97aa3c85d0` |

## Exam files

Hashes are the sha256 of each file's bytes as committed, with LF line endings. Check a file with `git show <commit>:eval/exam/<file> | sha256sum`.

| File | sha256 |
| --- | --- |
| `exam/e-01-one-person-at-monthly-limit_test.md` | `a9c2699728eeb758f9c725bf58f722111eac57864f237158aad5970620cf1189` |
| `exam/e-02-one-person-over-monthly-limit_test.md` | `d9f2e37c9dede10c369ed3bc6006d1d4746850d133a65204c03fb2bbec0b80ae` |
| `exam/e-03-one-person-at-weekly-limit_test.md` | `c4aae376819b7b7bd1c2bdc72b87e5558c839f41c2f5610cd97b5c1cb67fc6dc` |
| `exam/e-04-one-person-over-weekly-limit_test.md` | `f3bb7376c7c50b1a6021b4f57ba5dec0e47efed2f73db49ab993910937e68d50` |
| `exam/e-05-one-person-every-two-weeks-over_test.md` | `46b7ec02de09f90cd0d8ffc1845cf42ee4001fa37d52b36a5e0cdfa4d439154a` |
| `exam/e-06-one-person-every-two-weeks-under_test.md` | `fe1ade36d62ad6da19d97d38b053617bccf2114732f58084a2251836823ccd42` |
| `exam/e-07-eight-person-at-monthly-limit_test.md` | `816b6f65b6dc3650a3e88bcafdd539534f220968e4211fde38f0ba193ec42a48` |
| `exam/e-08-nine-person-at-monthly-limit_test.md` | `74b46d00bf2c80d1d9cfe6cdced3c28201f14c350a341632527d4c835c071f25` |
| `exam/e-09-nine-person-over-monthly-limit_test.md` | `7fc753ce7ee52ab6e44b689520921e7f0dfe570ae65750faf7af3bc5caab8786` |
| `exam/e-10-ten-person-at-yearly-limit_test.md` | `074d79974b3d63134379315a8dc2d347b330f3ca0ae9a9114095a053fb01cffc` |
| `exam/e-11-ssi-eligible-regardless-of-income_test.md` | `aa4e066181bfe4cc9fc580bf4f092fc48301ad8ac9062e697f89c0d68a3672d2` |
| `exam/e-12-medicaid-eligible-regardless-of-income_test.md` | `d1e3d608ee80a4bb4f47beb69c0f4f4bf900dd815daadfc6bd480e5b1637aed4` |
| `exam/e-13-zip-19103-outside-service-area_test.md` | `53801d6fc9c1596671bd83f6d8bf127469dc53a6b11c162b999c6d292295b2e6` |
| `exam/e-14-second-visit-same-month-refused_test.md` | `12cab5303a5ca5c7898a6a238718dfa3f97399f989602ef6388214b245078444` |
| `exam/e-15-visit-next-month-allowed_test.md` | `73c45c91981eef2e13bced8456c6a146e78fa918658744a62fa6e8384a0e82d0` |
| `exam/e-16-full-visit-time-refused_test.md` | `0a3b961b7390ef26abd5b4f1c977b4b8b0f8d8b0cbafb5de5160883cde200052` |
| `exam/e-17-proxy-on-volunteer-list_test.md` | `2a613620ffd6b6772553f2df310329a4d70f30ab40a8544997bbe5325fec5a83` |
| `exam/e-18-mark-picked-up-moves-visit_test.md` | `085f4c4d33cf9deeabfb18dd2114b188e010f9b67b36e3ae2026462b8e82c99a` |
| `exam/e-19-snap-outside-service-area_test.md` | `fa1fdab48c82e91845c810e1fa31f76c936e155fd1b3a27ed82b01aac3ee04ac` |
| `exam/e-20-four-person-at-weekly-limit_test.md` | `75e379bb9910a529b5344b3cb4054040cacb53e669d1ed3bf95337098ba3d48f` |
| `exam/e-21-three-person-every-two-weeks-over_test.md` | `e77341f49d5eb336fde8b1ecc80a5532ab8f6a77583960d2dbb343996d1ddec7` |
| `exam/e-22-sixth-household-fits_test.md` | `4699e648d64acef58f3dd0f9711dc27b7321e66ca7ee37567b62cd1cd1bfefed` |
