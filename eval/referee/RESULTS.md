# The referee, measured

The referee decides whether a planted bug that got past Kane's replay really breaks its criterion (`packages/core/src/breaker/referee.ts`). It has judged live twice, on 2026-11-18:

- **On the breaker's own model, `deepseek-v4-flash`**, shown only the criterion, its spec quotes and the patch, it judged 8 survivors. It was right on 4 by verdict, and on 3 with an account that holds.
- **On `z-ai-glm-5-3-flash`**, the default this page picked, shown the same, it was asked about 6 planted bugs that got past Kane's replays. It rejected 4, rightly; one call ran out of its token cap (that bug was set aside too, rightly); and it confirmed the one survivor, m-ac-19-1, wrongly. The patch turns `if (booked.proxy)` into `if (booked.proxy === undefined)`. The referee said an unnamed proxy is `undefined` and now shows "Proxy: undefined". But the app stores the proxy as `proxy TEXT NOT NULL DEFAULT ''` and renders the confirmation from that row, so an unnamed proxy is `''`. ac-19 (no proxy named: no Proxy line) still holds, and the patch breaks ac-18 (a named proxy's line) instead. From the patch alone the referee could not see where `booked` comes from.

So the referee is now shown the code, and must quote it:

- **The code:** each file the patch changes, before and after the change, whole while both fit in about 12k tokens (the pantry app's `src/server.js`, 458 lines, does). Past that it gets excerpts: the top-level statement around each change and the statements that define the names the changed lines use, a schema's columns and defaults among them (`packages/core/src/breaker/context.ts`).
- **The quote:** a confirmation must quote the line of the code after the change that makes the page show what it says. Holdback checks that the line is in the code it was shown, whitespace aside, and rejects the confirmation if it is not ("unsupported: …"). The check proves the line exists, not that it does what the referee says.

This page measures the referee with the code against the same labelled patches, plus m-ac-19-1, and keeps the first measurement, made with the patch alone, for comparison.

## How

- **The referee as falsify calls it:** `refereeMutant` unchanged, temperature 0, an 800-token cap, Venice's 120-second timeout. A call with no usable answer counts as not confirmed, as in falsify, where the survivor is then set aside.
- **The code it is shown:** each case's `code` names the app it was planted in, kept in `code/pantry-aad35d5/` (the pantry app's `src/server.js` at the commit every pantry case was planted on). The harness applies the patch to it in memory, as falsify does for a survivor it re-judges from the ledger. The rehearsal's app is not kept, so m-ac-4-1 is judged from the patch alone, as falsify does when the code has moved since the bug was planted; its quote must then be one of the patch's lines.
- **13 labelled patches** (`cases.json`): the 8 survivors the first live referee judged (6 logged before it existed, 2 from its own pass), the survivor m-ac-19-1 from the second, the rehearsal's real survivor m-ac-4-1, and 3 pantry kills whose patch plainly breaks its criterion (m-ac-21-1, m-ac-30-2, m-ac-28-2). Each label was checked against the patch applied to the app's last build, the criterion and `examples/pantry-spec/PRD.md`; `why` in `cases.json` says what each patch does.
- **Each patch 3 times on the default model, twice on the next best:** temperature 0 on Venice is not deterministic.
- **Run it:** `node eval/referee/run.ts run --models <a,b> --repeat 3 --cap 0.15` with `VENICE_API_KEY` set; `node eval/referee/run.ts table with-code` (or `patch-only`) sums `results/` without a key.

## The labels

5 patches break their criterion, 8 do not.

| Patch | Criterion | Label | What the patch does |
| --- | --- | --- | --- |
| m-ac-20-1 | ac-20, a phone number without 10 digits | no change | Inlines a variable: the same string is tested. |
| m-ac-53-1 | ac-53, the volunteer list shows today only | no change | Replaces a line with the identical line. |
| m-ac-36-1 | ac-36, an income result shows the income counted | no change | Adds `eligible: false` to an object whose own `eligible,` further down overrides it. |
| m-ac-26-1 | ac-26, no benefit, income at or below the limit: "Eligible." | off target | Changes only the branch for a household with a benefit. |
| m-ac-27-1 | ac-27, no benefit, income above the limit: "Not eligible." | off target | Treats an income of 0 like a benefit; 0 is never above a limit. |
| m-ac-37-1 | ac-37, an income result shows the limit | off target | Disables the benefit branch; every income result still shows the right limit. |
| m-ac-24-2 | ac-24, a ZIP outside the area: "Outside our service area." | off target | Adds an `else` after the out-of-area return: outside ZIPs are unchanged, every in-area household gets "Eligible.". |
| m-ac-19-1 | ac-19, no proxy named: no Proxy line | off target | `if (booked.proxy)` becomes `if (booked.proxy === undefined)`. The proxy comes from a `TEXT NOT NULL DEFAULT ''` column, written trimmed, so it is never `undefined`: no confirmation shows a Proxy line. ac-19 holds; ac-18 (a named proxy's line) breaks. |
| m-ac-31-2 | ac-31, each person beyond 8 adds the extra amount | **violates** | Hunk 1 replaces a line with the identical line; hunk 2 drops `* (size - 8)`: the same for 9 people, one increment short from 10 (10 people, yearly: $113,590 instead of $124,098). The ninth-member test cannot see it. |
| m-ac-4-1 | ac-4, the monthly limits table | **violates** | The limit for one person becomes $2,460 instead of $2,461. |
| m-ac-21-1 | ac-21, no visit time: "Choose a visit time." | **violates** | Comments the message out. |
| m-ac-30-2 | ac-30, biweekly income x 26 against the annual limit | **violates** | Compares biweekly income, unmultiplied, with the monthly column. |
| m-ac-28-2 | ac-28, no "Book a visit" on a result other than "Eligible." | **violates** | Adds the button to every other result. |

m-ac-31-2 was first counted as a patch that changes nothing. Its first hunk does; its second is a real bug, which the no-op filter rightly let through (`noOpReason` test in `packages/core/test/breaker.test.ts`). The first live referee's confirmation of it named a household of 9, for which the two formulas agree, so its verdict was right and its account wrong.

## Results, shown the code

13 patches; `results/with-code/`.

| Model | Right | False confirms | False rejects | No answer | $/call |
| --- | --- | --- | --- | --- | --- |
| `z-ai-glm-5-3-flash` (default) | 38/39 | 1 | 0 | 1 | 0.00173 |
| `claude-haiku-5-5` | 23/26 | 0 | 3 | 3 | 0.00194 |

Per patch, one letter per call (C confirmed, r rejected, – no usable answer):

| Patch | Label | glm-5-3-flash | haiku-5-5 |
| --- | --- | --- | --- |
| m-ac-20-1 | no change | rrr | rr |
| m-ac-53-1 | no change | rrr | rr |
| m-ac-36-1 | no change | rrr | rr |
| m-ac-26-1 | off target | rrr | rr |
| m-ac-27-1 | off target | rrr | rr |
| m-ac-37-1 | off target | –rr | rr |
| m-ac-24-2 | off target | Crr | rr |
| m-ac-19-1 | off target | rrr | rr |
| m-ac-31-2 | violates | CCC | CC |
| m-ac-4-1 | violates | CCC | CC |
| m-ac-21-1 | violates | CCC | –C |
| m-ac-30-2 | violates | CCC | C– |
| m-ac-28-2 | violates | CCC | –C |

- **m-ac-19-1, the live false confirmation:** rejected in all 5 calls, each time as off target: the no-proxy case is unchanged and only a named proxy's line breaks. `z-ai-glm-5-3-flash` traced the proxy to the `visits` column and its `DEFAULT ''` every time. Both models got it right in a one-call pilot first.
- **`z-ai-glm-5-3-flash`** confirmed m-ac-24-2 once in 3, quoting the added `else` line, which is in the code: it read the `else` as covering out-of-area ZIPs. The quote check cannot catch that. Its one call with no answer (m-ac-37-1) ran out of the 800-token cap mid-JSON. Calls took 1.3 to 21.8 seconds, 3.5 at the median.
- **`claude-haiku-5-5`** made no false confirmation, but 3 of its 26 calls ran out of the 800-token cap before finishing (one while reasoning, two mid-JSON). Each of those is a real bug falsify would have set aside.
- **The quote check never fired:** each of the 23 "violates" answers quoted a line that is in the code it was shown.
- **Not run again:** `openai-gpt-6-luna` (30/36 with the patch alone, 9 calls with no answer) and the rest, to stay within the run's budget.

## Results, shown only the patch (first measurement)

12 patches (m-ac-19-1 was not yet among them), prompt and schema as of `bdc0bee`; `results/patch-only/`.

| Model | Right | False confirms | False rejects | No answer | $/call |
| --- | --- | --- | --- | --- | --- |
| `z-ai-glm-5-3-flash` | 47/48 | 0 | 1 | 1 | 0.000222 |
| `claude-haiku-5-5` | 32/36 | 0 | 4 | 4 | 0.000371 |
| `openai-gpt-6-luna` | 30/36 | 0 | 6 | 9 | 0.000306 |
| `deepseek-v4-flash` (the breaker's model, baseline) | 29/36 | 7 | 0 | 0 | 0.000143 |
| `qwen3-235b-a22b-instruct-2507` | 28/36 | 5 | 3 | 0 | 0.000166 |

Per patch:

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
- **`z-ai-glm-5-3-flash`** named a household of 10 for m-ac-31-2 every time. Its one miss was a call that hit the 120-second timeout (m-ac-4-1). Live, a day later, it confirmed m-ac-19-1 wrongly, a patch this set did not have yet.
- **`openai-gpt-6-luna` and `claude-haiku-5-5`** reason before they answer, and 13 of their 72 calls ran out of the 800-token cap before any JSON.
- **Dropped after a one-call pilot on m-ac-24-2:** `qwen-3-7-plus` and `kimi-k2-6` spent the whole 800-token cap reasoning ($0.0020 and $0.0033 for no answer).

## The choice

`breaker.refereeModel` stays `z-ai-glm-5-3-flash`. Shown the code, it rejected the live false confirmation every time and confirmed every real bug every time, at $0.0017 a call. Its one false confirmation in 39 calls (m-ac-24-2) is a real weakness. `claude-haiku-5-5` made none in 26, but lost 3 of the 10 real bugs it was shown to the token cap, and each of those would have been set aside. Neither is clearly better. Showing the code costs about 8 times as much per call ($0.0017 against $0.0002 on `z-ai-glm-5-3-flash`).

## Limits

- 13 patches from one app, 5 of them real bugs; the labels are one person's reading of the code and the spec. 39 calls and 26 are too few to rank two models a call or two apart.
- The pantry file fits whole, so the excerpts were not measured live: they are unit-tested on it with a smaller cap (`packages/core/test/referee-code.test.ts`).
- The referee is still an LLM's judgment. Its quote is checked to be in the code; nothing checks that the line does what it says, and a patch's text can still steer it.
- A model's answers drift between runs at temperature 0; the same model on another day, or another app's patches, can do worse.

## Spend

- **First measurement:** $0.053 on Venice (the pilot $0.0064, the three passes $0.0436, the timed fourth GLM pass $0.0025), by the account's balance before and after; the cap was $0.30.
- **Shown the code:** booked $0.1218 at the listed prices (a one-call pilot of each model on m-ac-19-1 $0.0040, the GLM passes $0.0675, the haiku passes $0.0504) under a cap of $0.15. The account's balance dropped $0.1037 over the run.
