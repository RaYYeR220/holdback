---
assurance:
  id: t-3
  base: sha256:427c8bc7895109b1a98c51747d6423148f3ada008d1969934340feb58981d658
---
# Inclusive limits and published household-size schedule

> For sizes 1–9, at-limit incomes produce Eligible. and show each applicable limit; size 1 also exercises one dollar below its limit.

## Step 1 @verifies ac-8, ac-9, ac-10, ac-11

Open {{start_url}} in the browser and go to the “Food pantry eligibility check” page, then assert the page has the labelled Household size and Monthly household income ($) fields, the Someone in the household receives SNAP checkbox, and the Check eligibility button.

## Step 2 @verifies ac-1, ac-4, ac-6, ac-7

On the Food pantry eligibility check page, enter household size 1 and monthly household income $2,460, leave SNAP unchecked and check eligibility, then assert the result below the Check eligibility button says “Eligible.” and states an applied monthly limit of $2,461.

## Step 3 @verifies ac-1, ac-4, ac-6

On the Food pantry eligibility check page, enter household size 1 and monthly household income $2,461, leave SNAP unchecked and check eligibility, then assert the result says “Eligible.” and states an applied monthly limit of $2,461.

## Step 4 @verifies ac-1, ac-4, ac-6

On the Food pantry eligibility check page, enter household size 2 and monthly household income $3,337, leave SNAP unchecked and check eligibility, then assert the result says “Eligible.” and states an applied monthly limit of $3,337.

## Step 5 @verifies ac-1, ac-4, ac-6

On the Food pantry eligibility check page, enter household size 3 and monthly household income $4,212, leave SNAP unchecked and check eligibility, then assert the result says “Eligible.” and states an applied monthly limit of $4,212.

## Step 6 @verifies ac-1, ac-4, ac-6

On the Food pantry eligibility check page, enter household size 4 and monthly household income $5,088, leave SNAP unchecked and check eligibility, then assert the result says “Eligible.” and states an applied monthly limit of $5,088.

## Step 7 @verifies ac-1, ac-4, ac-6

On the Food pantry eligibility check page, enter household size 5 and monthly household income $5,964, leave SNAP unchecked and check eligibility, then assert the result says “Eligible.” and states an applied monthly limit of $5,964.

## Step 8 @verifies ac-1, ac-4, ac-6

On the Food pantry eligibility check page, enter household size 6 and monthly household income $6,839, leave SNAP unchecked and check eligibility, then assert the result says “Eligible.” and states an applied monthly limit of $6,839.

## Step 9 @verifies ac-1, ac-4, ac-6

On the Food pantry eligibility check page, enter household size 7 and monthly household income $7,715, leave SNAP unchecked and check eligibility, then assert the result says “Eligible.” and states an applied monthly limit of $7,715.

## Step 10 @verifies ac-1, ac-4, ac-6

On the Food pantry eligibility check page, enter household size 8 and monthly household income $8,591, leave SNAP unchecked and check eligibility, then assert the result says “Eligible.” and states an applied monthly limit of $8,591.

## Step 11 @verifies ac-1, ac-5, ac-6

On the Food pantry eligibility check page, enter household size 9 and monthly household income $9,467, leave SNAP unchecked and check eligibility, then assert the result says “Eligible.” and states the applied monthly limit is $9,467 ($8,591 plus $876 for the ninth member).
