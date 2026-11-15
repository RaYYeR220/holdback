---
assurance:
  id: t-1
  base: sha256:ff842a51e0a7b7f2bdcb272533e98612f5f415be7d95600dae16ecabd5f706ba
---
# Income above limit returns Not eligible without SNAP

> For household sizes 1, 8 and 9, income one dollar above each applicable limit yields Not eligible. and states the applied limit.

## Step 1 @verifies ac-8, ac-9, ac-10, ac-11

Open {{start_url}} in the browser and go to the “Food pantry eligibility check” page, then assert the page has the labelled Household size and Monthly household income ($) fields, the Someone in the household receives SNAP checkbox, and the Check eligibility button.

## Step 2 @verifies ac-2, ac-6, ac-7

On the Food pantry eligibility check page, enter household size 1 and monthly household income $2,462, leave Someone in the household receives SNAP unchecked and check eligibility, then assert the result below the Check eligibility button says “Not eligible.” and states an applied monthly limit of $2,461.

## Step 3 @verifies ac-2, ac-6

On the Food pantry eligibility check page, enter household size 8 and monthly household income $8,592, leave Someone in the household receives SNAP unchecked and check eligibility, then assert the result says “Not eligible.” and states an applied monthly limit of $8,591.

## Step 4 @verifies ac-2, ac-5, ac-6

On the Food pantry eligibility check page, enter household size 9 and monthly household income $9,468, leave Someone in the household receives SNAP unchecked and check eligibility, then assert the result says “Not eligible.” and states the applied monthly limit is $9,467 ($8,591 plus $876 for the ninth member).
