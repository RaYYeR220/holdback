---
assurance:
  id: t-4
  base: sha256:6e83b0d3cac0d610534ac28affbcefe7a902ed931757b6382aa6e2e7d0785678
---
# Nine-person household earning $9,000 uses the $9,467 limit

> For household size 9 and monthly income $9,000 without SNAP, the result is “Eligible.” and states the applied monthly limit of $9,467, distinguishing the above-eight-member rule from the $8,591 limit for size 8.

## Step 1 @verifies ac-8, ac-9, ac-10, ac-11

Open {{start_url}} in the browser and reach the “Food pantry eligibility check” page, then assert the page has the “Household size” and “Monthly household income ($)” fields, the “Someone in the household receives SNAP” checkbox, and the “Check eligibility” button.

## Step 2 @verifies ac-1, ac-5, ac-6, ac-7

On the “Food pantry eligibility check” page, enter household size 9 and monthly household income $9,000, leave “Someone in the household receives SNAP” unchecked, and use “Check eligibility”, then assert the result below that button says “Eligible.” and states the applied monthly limit is $9,467 rather than $8,591.
