---
assurance:
  id: t-2
  base: sha256:dc27e8dc9d5ebe8a1bd7c9d5c20f16d7e8ed088587dcf7cdcd19a17dac9ac97d
---
# Nine-person household qualifies at $9,467

> For a nine-person household without SNAP and monthly income $9,467, the additional-member rule yields an applied limit of $9,467 and eligibility at equality.

## Step 1 @verifies ac-6, ac-7, ac-8, ac-9

At {{start_url}}, open the “Food pantry eligibility check” page, then assert it has an input labelled “Household size”, an input labelled “Monthly household income ($)”, a checkbox labelled “Someone in the household receives SNAP”, and a “Check eligibility” button.

## Step 2 @verifies ac-2, ac-4, ac-5

On the “Food pantry eligibility check” page, set Household size to 9 and Monthly household income ($) to 9467, leave “Someone in the household receives SNAP” unselected, and request “Check eligibility”; then assert the result below the button says “Eligible.” and states the applied monthly limit of $9,467.
