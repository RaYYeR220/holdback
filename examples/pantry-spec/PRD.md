# Food pantry intake and visit booking

We run a food pantry in West and Southwest Philadelphia that hands out USDA food under The Emergency Food Assistance Program (TEFAP). This web app replaces our paper intake sheet and our phone booking line. A household checks whether it can get TEFAP food from us, books a pickup visit and may name a proxy who can pick up for them. Volunteers at the door use the volunteer list to see today's visits and mark each pickup.

## Pages

1. The app has three pages: "Food pantry eligibility check", "Book a visit" and "Volunteer list"; each page shows its name as its heading.
2. The eligibility check is the home page.
3. Every page has two links at the top: "Eligibility check", which opens the eligibility check, and "Volunteer list", which opens the volunteer list.
4. Nobody signs in; every page is open to anyone who has the link.

## Eligibility check

5. The eligibility check has these fields, in this order: "Household size", "Household income ($)", "How often is this income received?", "Does anyone in the household receive any of these benefits?" and "ZIP code", followed by a "Check eligibility" button.
6. "Household size" is the number of people who live together and share food; it must be a whole number of 1 or more.
7. "Household income ($)" is the total income of everyone in the household before taxes, in dollars; it may be 0 and may include cents.
8. "How often is this income received?" has exactly four options, "Weekly", "Every two weeks", "Monthly" and "Yearly"; none is chosen until the person chooses one.
9. "Does anyone in the household receive any of these benefits?" has four checkboxes, "SNAP", "TANF", "SSI" and "Medicaid"; none is ticked at first, and any number may be ticked.
10. "ZIP code" must be exactly 5 digits.
11. Every field except the benefit checkboxes must be filled in, even when a benefit is ticked.
12. When "Check eligibility" is chosen, the result appears on the same page below the button, and the form keeps the values that were entered.
13. If a field is missing or invalid, the page shows that field's message from the Messages section and no result.

## Who is eligible

14. We serve ZIP codes 19104, 19139 and 19143 only.
15. A household with any other ZIP code gets the out-of-area result and no eligibility result, even when a benefit is ticked.
16. A household in our ZIP codes is eligible regardless of income when anyone in it receives SNAP, TANF, SSI or Medicaid.
17. Every other household in our ZIP codes is eligible when its income is at or below the income limit for its household size, and not eligible when its income is above that limit.
18. The income limit comes from the income limits table below, from the column that matches how often the income is received.
19. Weekly income is compared with the Weekly column.
20. Monthly income is compared with the Monthly column.
21. Yearly income is compared with the Annual column.
22. Income received every two weeks is multiplied by 26, and the result is compared with the Annual column.
23. For a household of more than 8 people, the limit is the limit for 8 people plus the "Each additional member" amount of the same column for every person above 8.
24. The limits are used exactly as published; a limit is never worked out from another column.

### Income limits

Pennsylvania TEFAP income guidelines, Total Household Income (based on 185% of Poverty), effective July 1, 2026 to June 30, 2027.

Source: https://www.pa.gov/en/agencies/pda/food/food-assistance/the-emergency-food-assistance-program.html

| Household size | Annual | Monthly | Weekly |
| --- | --- | --- | --- |
| 1 | $29,526 | $2,461 | $568 |
| 2 | $40,034 | $3,337 | $770 |
| 3 | $50,542 | $4,212 | $972 |
| 4 | $61,050 | $5,088 | $1,175 |
| 5 | $71,558 | $5,964 | $1,377 |
| 6 | $82,066 | $6,839 | $1,579 |
| 7 | $92,574 | $7,715 | $1,781 |
| 8 | $103,082 | $8,591 | $1,983 |
| Each additional member | +$10,508 | +$876 | +$203 |

## Eligibility result

25. The out-of-area result is two lines: "Outside our service area." and "We serve ZIP codes 19104, 19139 and 19143 only."
26. A household that is eligible because of a benefit sees two lines: "Eligible." and "Reason: someone in the household receives SNAP, TANF, SSI or Medicaid."
27. A household decided by income sees three lines: "Eligible." or "Not eligible.", then "Income counted: {income} per {period}.", then "Limit applied: {limit} per {period} for a household of {size}."
28. In those lines, {period} is "week" for weekly income, "month" for monthly income, and "year" for yearly income and for income received every two weeks.
29. For income received every two weeks, {income} is the amount entered multiplied by 26; otherwise it is the amount entered.
30. Example: a household of 2 with $3,400 monthly income and no benefits sees "Not eligible.", "Income counted: $3,400 per month." and "Limit applied: $3,337 per month for a household of 2."
31. Example: a household of 4 with $1,500 received every two weeks and no benefits sees "Eligible.", "Income counted: $39,000 per year." and "Limit applied: $61,050 per year for a household of 4."
32. Every "Eligible." result also has a "Book a visit" button that opens the Book a visit page for that household; other results have no such button.

## Formats

33. Money is shown with a dollar sign and thousands separators, such as $29,526; cents are shown only when an amount has cents, such as $1,135.50.
34. Dates are shown with the weekday, month, day and year, such as Tuesday, December 1, 2026.
35. Times are shown on a 24-hour clock, such as 10:00 and 13:00.
36. Phone numbers are shown as 215-555-0101.
37. All dates and times are the pantry's local time.

## Booking a visit

38. The Book a visit page has the fields "Phone number", "Visit time" and "Proxy name (optional)", followed by a "Book visit" button.
39. If the Book a visit page is opened without an "Eligible." result, it shows the message "Check eligibility first." and no form.
40. A household is identified by its phone number.
41. "Phone number" must contain exactly 10 digits; spaces, dashes, dots and parentheses are ignored, so (215) 555-0101 and 215-555-0101 are the same household.
42. Visits happen on Tuesdays, Thursdays and Saturdays.
43. Each visit day has four one-hour visit times: 10:00, 11:00, 12:00 and 13:00 (we are open from 10:00 to 14:00).
44. Each visit time takes at most 6 households.
45. "Visit time" lists every visit time of the 28 days that start with today (today and the 27 days after it), earliest first.
46. Each listed visit time reads like "Tuesday, December 1, 2026 at 10:00".
47. A visit time can be booked until the end of its day, so today's visit times stay listed and can be booked all day.
48. A visit time that already has 6 visits stays listed with " — Full" after it, such as "Tuesday, December 1, 2026 at 10:00 — Full", and cannot be booked.
49. A household can have only one visit in each calendar month; the month is the month of the visit date.
50. A household that already has a visit in a calendar month cannot book another visit in that month, but can book a visit in another month.
51. A household may name one proxy, a person who can pick up the food for them; the proxy is optional.
52. A visit keeps the household size from the eligibility check that led to it.
53. When a visit is booked, the page shows "Visit booked.", then "Your visit: {date} at {time}.", then, if a proxy was named, "Proxy: {proxy name}".
54. If a booking breaks a rule above, the page shows the matching message from the Messages section, keeps the entered values and books nothing.

## Volunteer list

55. The volunteer list shows today's visits only, below the line "Visits for {today's date}".
56. Today's visits are in two sections, "Expected today" and "Picked up".
57. Each section lists its visits by visit time, earliest first, with the columns "Time", "Phone number", "Household size" and "Proxy".
58. The "Proxy" column shows the proxy's name, or stays empty when no proxy was named.
59. Each visit under "Expected today" has a "Mark picked up" button.
60. "Mark picked up" moves that visit from "Expected today" to "Picked up"; the change is saved and stays after the page is reloaded.
61. Visits under "Picked up" have no button; a pickup cannot be undone.
62. A section with no visits shows "No visits."

## Messages

| When | Message |
| --- | --- |
| "Household size" is empty or not a whole number of 1 or more | Enter a household size of 1 or more. |
| "Household income ($)" is empty, negative or not a number | Enter the household income in dollars. |
| No option is chosen for "How often is this income received?" | Choose how often this income is received. |
| "ZIP code" is not exactly 5 digits | Enter a 5-digit ZIP code. |
| "Phone number" does not contain exactly 10 digits | Enter a 10-digit phone number. |
| No "Visit time" is chosen | Choose a visit time. |
| The household already has a visit in the month of the chosen visit time | This household already has a visit booked in that month. |
| The chosen visit time already has 6 visits | That visit time is full. Choose another time. |
| The Book a visit page is opened without an "Eligible." result | Check eligibility first. |

## Not included

- Signing in, user accounts or roles.
- Cancelling or changing a visit.
- Reminders by text message or email.
- Languages other than English.
