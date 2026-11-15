# Pre-registered exam

The exam in `eval/exam/` measures how much of the pantry spec a finished app really does, on cases where a plausible misreading of `examples/pantry-spec/PRD.md` gives a different answer: income exactly at and $1 above the limit in the weekly, monthly, yearly and every-two-weeks forms, households above 8 people, limits that only match when the published column is used, benefits that make a household eligible regardless of income, ZIP codes outside the service area (also when a benefit is ticked), one visit per household per calendar month, a full visit time, the proxy on the volunteer list and marking a pickup. Each case is one `_test.md` file run in a real browser, with a single decisive check in its last step; the expected result of every case is computed by `eval/reference.ts` from the Pennsylvania TEFAP table (effective July 1, 2026 to June 30, 2027) and the PRD, and `eval/reference.test.ts` ties each file's wording and expected result to that reference. The exam was written from the regulation and the PRD and committed, with the hashes below, before any build arm or any Holdback run; no build arm and no Holdback test-design step sees it.

## How it is run

- The app under test starts once, on an empty `DATA_DIR`, with `HOLDBACK_TODAY` set to a Tuesday, Thursday or Saturday on or after the 7th of its month (`nextExamToday()` in `eval/reference.ts` picks one). This makes the first listed visit time today's 10:00 and puts visit times of the next calendar month inside the 28-day booking window.
- The `start_url` variable is the app's base URL.
- Each file runs once with `kane-cli testmd run`, in any order; the booking cases use their own phone numbers and do not depend on each other. A case passes when its run passes. The score is passed cases out of 21.
- The exam id is the `tags` entry `e-NN` (Kane's frontmatter accepts `tags`, not custom keys).

## Files

Hashes are sha256 of each file's bytes as committed (LF line endings). Check with `git show <commit>:eval/exam/<file> | sha256sum`.

| File | sha256 |
| --- | --- |
| `exam/e-01-one-person-at-monthly-limit_test.md` | `21d0d064857d7c33c9813f15568ebf956df53ddea2bc84b1f71eeef99adf4321` |
| `exam/e-02-one-person-over-monthly-limit_test.md` | `d9f2e37c9dede10c369ed3bc6006d1d4746850d133a65204c03fb2bbec0b80ae` |
| `exam/e-03-one-person-at-weekly-limit_test.md` | `00c1d5d7ae1b6d9340bf2c428b4bec1e1cc56c7b3747f0bda87e1748c5ce2647` |
| `exam/e-04-one-person-over-weekly-limit_test.md` | `f3bb7376c7c50b1a6021b4f57ba5dec0e47efed2f73db49ab993910937e68d50` |
| `exam/e-05-one-person-every-two-weeks-over_test.md` | `46b7ec02de09f90cd0d8ffc1845cf42ee4001fa37d52b36a5e0cdfa4d439154a` |
| `exam/e-06-one-person-every-two-weeks-under_test.md` | `744bdd229a062b5231ece8f2e0c91937939c38620615216e6f72a763dbe9db61` |
| `exam/e-07-eight-person-at-monthly-limit_test.md` | `47b40033895072797885c5bb834c2bccd74eeedcea37ff9455af9c5e1f41f585` |
| `exam/e-08-nine-person-at-monthly-limit_test.md` | `88599652e402ca1e9b0229ec18195065b4429052d987c8a12ae5b398730fd27d` |
| `exam/e-09-nine-person-over-monthly-limit_test.md` | `7fc753ce7ee52ab6e44b689520921e7f0dfe570ae65750faf7af3bc5caab8786` |
| `exam/e-10-ten-person-at-yearly-limit_test.md` | `bd19136c2556395204d5851022517a862d529055ce76460a483f800ad394f1ba` |
| `exam/e-11-ssi-eligible-regardless-of-income_test.md` | `2592873d10463a4f0fb83e216440f98325856ec672644da3ceb5c7b9f1d7c5f3` |
| `exam/e-12-medicaid-eligible-regardless-of-income_test.md` | `a1e86bf72493ad3cdd7604ece1738dae855f8c6359312470238c1baabb788874` |
| `exam/e-13-zip-19103-outside-service-area_test.md` | `53801d6fc9c1596671bd83f6d8bf127469dc53a6b11c162b999c6d292295b2e6` |
| `exam/e-14-second-visit-same-month-refused_test.md` | `565a64cf1a92bbb636c7350b3fb90323740352f5430af301a5d4ebf8fb1f12ad` |
| `exam/e-15-visit-next-month-allowed_test.md` | `87eabe706cc765db89e86745f14a74a61cb1e1dd42e39807fa77c84912129ec8` |
| `exam/e-16-full-visit-time-refused_test.md` | `d84409f1cfd55b15a838d5448f8f5b9c7a791079cf90760196dbbbe0444274e9` |
| `exam/e-17-proxy-on-volunteer-list_test.md` | `60083ee6717fb94f68521487a3dcd83b602ca217f1afcd6921e18d8d81f4b204` |
| `exam/e-18-mark-picked-up-moves-visit_test.md` | `99962af56cef2c3a6fe11ee6f276a2fe5f4649a0c154576ee8f1d2c495deb2bf` |
| `exam/e-19-snap-outside-service-area_test.md` | `fa1fdab48c82e91845c810e1fa31f76c936e155fd1b3a27ed82b01aac3ee04ac` |
| `exam/e-20-four-person-at-weekly-limit_test.md` | `daf0ba245ec3bb120fe8d61209dc13180ce80fbd4aab9a7e01c1d1518c3559ad` |
| `exam/e-21-three-person-every-two-weeks-over_test.md` | `e77341f49d5eb336fde8b1ecc80a5532ab8f6a77583960d2dbb343996d1ddec7` |
