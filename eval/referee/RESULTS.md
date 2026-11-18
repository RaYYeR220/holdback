# The referee, measured

The referee decides whether a planted bug that got past Kane's replay really breaks its criterion (`packages/core/src/breaker/referee.ts`). In the pantry run's second falsify pass, 2026-11-18, it ran on the breaker's own model, `deepseek-v4-flash`, and judged 8 survivors. It was right on 4 by verdict, and on 3 with an account that holds. This page measures the same prompt on other Venice models and picks the default for `breaker.refereeModel`.

## How

- **The referee as falsify calls it:** `refereeMutant` unchanged (prompt and schema as of `bdc0bee`), temperature 0, an 800-token cap, Venice's 120-second timeout. A call with no usable answer counts as not confirmed, as in falsify, where the survivor is then set aside.
- **12 labelled patches** (`cases.json`): the 8 survivors the live referee judged (6 logged before it existed, 2 from its own pass), the rehearsal's real survivor m-ac-4-1, and 3 pantry kills whose patch plainly breaks its criterion (m-ac-21-1, m-ac-30-2, m-ac-28-2). Each label was checked against the patch applied to the app's last build, the criterion and `examples/pantry-spec/PRD.md`; `why` in `cases.json` says what each patch does.
- **Each patch 3 times per model** (4 for the one picked): temperature 0 on Venice is not deterministic. `deepseek-v4-flash` rejected m-ac-24-2 and m-ac-27-1 3 times out of 3 here, and confirmed both live.
- **Run it:** `node eval/referee/run.ts run --models <a,b> --repeat 3 --cap 0.30` with `VENICE_API_KEY` set; `node eval/referee/run.ts table` sums `results/` without a key.

## The labels

5 patches break their criterion, 7 do not.

| Patch | Criterion | Label | What the patch does |
| --- | --- | --- | --- |
| m-ac-20-1 | ac-20, a phone number without 10 digits | no change | Inlines a variable: the same string is tested. |
| m-ac-53-1 | ac-53, the volunteer list shows today only | no change | Replaces a line with the identical line. |
| m-ac-36-1 | ac-36, an income result shows the income counted | no change | Adds `eligible: false` to an object whose own `eligible,` further down overrides it. |
| m-ac-26-1 | ac-26, no benefit, income at or below the limit: "Eligible." | off target | Changes only the branch for a household with a benefit. |
| m-ac-27-1 | ac-27, no benefit, income above the limit: "Not eligible." | off target | Treats an income of 0 like a benefit; 0 is never above a limit. |
| m-ac-37-1 | ac-37, an income result shows the limit | off target | Disables the benefit branch; every income result still shows the right limit. |
| m-ac-24-2 | ac-24, a ZIP outside the area: "Outside our service area." | off target | Adds an `else` after the out-of-area return: outside ZIPs are unchanged, every in-area household gets "Eligible.". |
| m-ac-31-2 | ac-31, each person beyond 8 adds the extra amount | **violates** | Hunk 1 replaces a line with the identical line; hunk 2 drops `* (size - 8)`: the same for 9 people, one increment short from 10 (10 people, yearly: $113,590 instead of $124,098). The ninth-member test cannot see it. |
| m-ac-4-1 | ac-4, the monthly limits table | **violates** | The limit for one person becomes $2,460 instead of $2,461. |
| m-ac-21-1 | ac-21, no visit time: "Choose a visit time." | **violates** | Comments the message out. |
| m-ac-30-2 | ac-30, biweekly income x 26 against the annual limit | **violates** | Compares biweekly income, unmultiplied, with the monthly column. |
| m-ac-28-2 | ac-28, no "Book a visit" on a result other than "Eligible." | **violates** | Adds the button to every other result. |

m-ac-31-2 was first counted as a patch that changes nothing. Its first hunk does; its second is a real bug, which the no-op filter rightly let through (`noOpReason` test in `packages/core/test/breaker.test.ts`). The live referee's confirmation of it named a household of 9, for which the two formulas agree, so its verdict was right and its account wrong.

## Results

| Model | Right | False confirms | False rejects | No answer | $/call |
| --- | --- | --- | --- | --- | --- |
| `z-ai-glm-5-3-flash` | 47/48 | 0 | 1 | 1 | 0.000222 |
| `claude-haiku-5-5` | 32/36 | 0 | 4 | 4 | 0.000371 |
| `openai-gpt-6-luna` | 30/36 | 0 | 6 | 9 | 0.000306 |
| `deepseek-v4-flash` (the breaker's model, baseline) | 29/36 | 7 | 0 | 0 | 0.000143 |
| `qwen3-235b-a22b-instruct-2507` | 28/36 | 5 | 3 | 0 | 0.000166 |

Per patch, one letter per call (C confirmed, r rejected, – no usable answer):

| Patch | Label | glm-5-3-flash | haiku-5-5 | gpt-6-luna | deepseek-v4-flash | qwen3-235b |
| --- | --- | --- | --- | --- | --- | --- |
| m-ac-20-1 | no change | rrrr | rrr | rrr | rrr | rrr |
| m-ac-53-1 | no change | rrrr | rrr | rrr | rrr | rrr |
| m-ac-36-1 | no change | rrrr | rrr | –r– | CCC | CrC |
| m-ac-26-1 | off target | rrrr | rrr | rrr | CCC | rrr |
| m-ac-27-1 | off target | rrrr | rrr | rrr | rrr | rrr |
| m-ac-37-1 | off target | rrrr | rrr | –rr | rCr | rrr |
| m-ac-24-2 | off target | rrrr | rrr | rrr | rrr | CCC |
| m-ac-31-2 | violates | CCCC | ––C | ––– | CCC | rCr |
| m-ac-4-1 | violates | CC–C | CCC | CCC | CCC | CCC |
| m-ac-21-1 | violates | CCCC | CCC | CCC | CCC | CCC |
| m-ac-30-2 | violates | CCCC | –C– | ––– | CCC | CCC |
| m-ac-28-2 | violates | CCCC | CCC | CCC | CCC | CrC |

- **`deepseek-v4-flash`** confirms the patches it cannot see through: m-ac-36-1 and m-ac-26-1 every time. On m-ac-31-2 it named a household of 9 every time, the one size where nothing changes.
- **`z-ai-glm-5-3-flash`** named a household of 10 for m-ac-31-2 every time. Its one miss was a call that hit the 120-second timeout (m-ac-4-1); the 12 calls timed afterwards took 1.3 to 12.4 seconds, 3.3 at the median.
- **`openai-gpt-6-luna` and `claude-haiku-5-5`** reason before they answer, and 13 of their 72 calls ran out of the 800-token cap before any JSON.
- **Dropped after a one-call pilot on m-ac-24-2:** `qwen-3-7-plus` and `kimi-k2-6` spent the whole 800-token cap reasoning ($0.0020 and $0.0033 for no answer). The pilot's other answers are not counted above.
- **No prompt change was tried:** one model got 47 of 48 right with the current prompt.

## The choice

`breaker.refereeModel` defaults to `z-ai-glm-5-3-flash`: no false confirmation, every real bug confirmed but for the one call that timed out, each time with an input that shows it (once with a second example, a household size of 0, that shows nothing), another family than the breaker's `deepseek-v4-flash`, at $0.0002 a call.

## Limits

- 12 patches from one app, 5 of them real bugs; the labels are one person's reading of the code and the spec.
- The referee is still an LLM's judgment: its words are not checked against the code, and a patch's text can still steer it.
- A model's answers drift between runs at temperature 0; the same model on another day, or another app's patches, can do worse.

## Spend

$0.053 in all on Venice (the pilot $0.0064, the three passes $0.0436, the timed fourth GLM pass $0.0025), by the account's balance before and after; the cap was $0.30.
