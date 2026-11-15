---
assurance:
  id: t-3
  base: sha256:58ac55344b399199979383fb0535ce5cc2ab5fd24d03f008286403b951b093e6
---
# Non-SNAP household above $2,461 is not eligible

> For a one-person household without SNAP earning $2,462 monthly, the result excludes eligibility and reports the $2,461 limit.

## Step 1 @verifies ac-6, ac-7, ac-8, ac-9

At {{start_url}}, open the “Food pantry eligibility check” page, then assert it has an input labelled “Household size”, an input labelled “Monthly household income ($)”, a checkbox labelled “Someone in the household receives SNAP”, and a “Check eligibility” button.

## Step 2 @verifies ac-3, ac-4, ac-5

On the “Food pantry eligibility check” page, set Household size to 1 and Monthly household income ($) to 2462, leave “Someone in the household receives SNAP” unselected, and request “Check eligibility”; then assert the result below the button says “Not eligible.” and states the applied monthly limit of $2,461.
