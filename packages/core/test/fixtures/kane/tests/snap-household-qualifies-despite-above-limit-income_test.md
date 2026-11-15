---
assurance:
  id: t-1
  base: sha256:04f03ff0b13398efc87224bee77fd38b09420a9cf5d8f6b1ef13f6c261a80706
---
# SNAP household qualifies despite above-limit income

> For a one-person household with monthly income $2,462 and someone receiving SNAP, eligibility is positive despite exceeding the $2,461 limit, and the applied limit is reported.

## Step 1 @verifies ac-6, ac-7, ac-8, ac-9

At {{start_url}}, open the “Food pantry eligibility check” page, then assert it has an input labelled “Household size”, an input labelled “Monthly household income ($)”, a checkbox labelled “Someone in the household receives SNAP”, and a “Check eligibility” button.

## Step 2 @verifies ac-1, ac-4, ac-5

On the “Food pantry eligibility check” page, set Household size to 1 and Monthly household income ($) to 2462, select “Someone in the household receives SNAP”, and request “Check eligibility”; then assert the result below the button says “Eligible.” and states the applied monthly limit of $2,461.
