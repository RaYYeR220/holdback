---
assurance:
  id: t-2
  base: sha256:b5f4a24474dce22fc66c8dfdf9aa675c39e3a4457c94efb6ceab179f5baa9189
---
# Prevent a second monthly visit for a normalized phone

> Use the same ten digits in a different accepted punctuation format to try a second visit in its visit-date month; retain inputs and create no second visit.

## Import: t-1

@import ./C:\Users\dev\.holdback\0123456789ab\verifier\.testmuai\tests\book-an-available-visit-and-confirm-proxy-and-schedule_test.md

## Step 1

At {{start_url}}, on Food pantry eligibility check, obtain an Eligible. result for household size 4, $1,500 income received every two weeks, no benefits and ZIP code 19104, then open Book a visit for another attempt using the already-booked household {{primary_phone}}.

## Step 2 @verifies ac-11, ac-22

On Book a visit, enter {{primary_phone_formatted}} (the same ten digits as {{primary_phone}} with different permitted punctuation) and choose another available visit time in the same calendar month as the prior booking, then submit Book visit and assert 'This household already has a visit booked in that month.' appears for the same household rather than a new success confirmation.

## Step 3 @verifies ac-4

On the rejected Book a visit form, inspect the entered phone and chosen visit time after the rejection, then assert both remain entered.
