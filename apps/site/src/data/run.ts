/**
 * The first live run's design: Kane CLI Assurance read a 4-rule food-pantry spec and designed these
 * 11 acceptance criteria. `text` is Kane's wording; `label` and `short` are trimmed for the field.
 */
export type Criterion = { id: string; text: string; label: string; short: string };

export const CRITERIA: Criterion[] = [
  {
    id: "ac-1",
    text: "For a household without SNAP whose monthly income is at or below its applicable monthly limit, the result says “Eligible.”",
    label: "No SNAP, income at or below the limit → “Eligible.”",
    short: "≤ limit → Eligible",
  },
  {
    id: "ac-2",
    text: "For a household without SNAP whose monthly income exceeds its applicable monthly limit, the result says “Not eligible.”",
    label: "No SNAP, income above the limit → “Not eligible.”",
    short: "> limit → Not eligible",
  },
  {
    id: "ac-3",
    text: "For a household with someone receiving SNAP, the result says “Eligible.” regardless of monthly income.",
    label: "Someone receives SNAP → “Eligible.” at any income",
    short: "SNAP → Eligible",
  },
  {
    id: "ac-4",
    text: "For sizes 1 through 8, the applied monthly limit equals the corresponding published limit: 1=$2,461; 2=$3,337; 3=$4,212; 4=$5,088; 5=$5,964; 6=$6,839; 7=$7,715; 8=$8,591.",
    label: "Sizes 1–8 apply the published limits, $2,461 to $8,591",
    short: "Sizes 1–8 = table",
  },
  {
    id: "ac-5",
    text: "For household sizes above 8, the applied monthly limit equals $8,591 plus $876 for each member above 8.",
    label: "Above 8 people: $8,591 plus $876 per extra member",
    short: "Over 8: +$876 each",
  },
  {
    id: "ac-6",
    text: "The result states the applied monthly limit.",
    label: "The result states the applied monthly limit",
    short: "States the limit",
  },
  {
    id: "ac-7",
    text: "The result appears below the “Check eligibility” button.",
    label: "The result appears below “Check eligibility”",
    short: "Result below button",
  },
  {
    id: "ac-8",
    text: "The page has a field labelled “Household size”.",
    label: "A field labelled “Household size”",
    short: "Household size field",
  },
  {
    id: "ac-9",
    text: "The page has a field labelled “Monthly household income ($)”.",
    label: "A field labelled “Monthly household income ($)”",
    short: "Income field",
  },
  {
    id: "ac-10",
    text: "The page has a checkbox labelled “Someone in the household receives SNAP”.",
    label: "A checkbox labelled “Someone in the household receives SNAP”",
    short: "SNAP checkbox",
  },
  {
    id: "ac-11",
    text: "The page has a button labelled “Check eligibility”.",
    label: "A button labelled “Check eligibility”",
    short: "Check button",
  },
];

/** The two bugs the breaker planted in the live run, and Kane's verdict on the replay that caught each. */
export type Mutant = { ac: string; minus: string; plus: string; diagnosis: string; severity: string; confidence: number };

export const MUTANTS: Mutant[] = [
  {
    ac: "ac-2",
    minus: "income <= limit",
    plus: "income >= limit",
    diagnosis: "Eligibility checker approves income above displayed monthly limit",
    severity: "major",
    confidence: 0.99,
  },
  {
    ac: "ac-3",
    minus: "snap || (… income <= limit)",
    plus: "(… income <= limit)",
    diagnosis: "SNAP household incorrectly marked ineligible above displayed income limit",
    severity: "major",
    confidence: 0.98,
  },
];

/** Criteria the loop shows failing Kane's first check (an illustration of the mechanism, not the live run's order). */
export const FIRST_FAIL = new Set(["ac-1", "ac-4", "ac-5"]);
