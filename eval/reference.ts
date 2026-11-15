// Reference model of the pantry PRD (examples/pantry-spec/PRD.md), used to
// compute the expected outcome of every exam case in eval/exam/. Pure: no I/O,
// no clock. Money is handled in whole cents.

// Pennsylvania TEFAP income guidelines, "Total Household Income (based on 185%
// of Poverty)", effective July 1, 2026 to June 30, 2027.
// https://www.pa.gov/en/agencies/pda/food/food-assistance/the-emergency-food-assistance-program.html
// Index 0 = household of 1 ... index 7 = household of 8. Whole dollars.
export const ANNUAL = [29_526, 40_034, 50_542, 61_050, 71_558, 82_066, 92_574, 103_082] as const;
export const MONTHLY = [2_461, 3_337, 4_212, 5_088, 5_964, 6_839, 7_715, 8_591] as const;
export const WEEKLY = [568, 770, 972, 1_175, 1_377, 1_579, 1_781, 1_983] as const;
export const INCREMENT = { annual: 10_508, monthly: 876, weekly: 203 } as const;

export const SERVICE_ZIPS = ["19104", "19139", "19143"] as const;

export type Column = "annual" | "monthly" | "weekly";
export type Frequency = "weekly" | "every-two-weeks" | "monthly" | "yearly";
export type Benefit = "SNAP" | "TANF" | "SSI" | "Medicaid";

export interface EligibilityInput {
  householdSize: number;
  /** Dollars, as typed into "Household income ($)"; may have cents. */
  income: number;
  frequency: Frequency;
  benefits: Benefit[];
  zip: string;
}

export type Expected =
  | { result: "outside-area"; lines: string[] }
  | { result: "eligible"; reason: "benefit"; lines: string[] }
  | {
      result: "eligible" | "not-eligible";
      reason: "income";
      column: Column;
      /** Cents, after the every-two-weeks x26 conversion. */
      incomeCounted: number;
      /** Whole dollars. */
      limit: number;
      lines: string[];
    };

const COLUMNS: Record<Column, readonly number[]> = { annual: ANNUAL, monthly: MONTHLY, weekly: WEEKLY };
const PERIOD: Record<Column, string> = { annual: "year", monthly: "month", weekly: "week" };

/** Published limit in whole dollars; above 8 people, add the same column's increment per extra person. */
export function limitFor(householdSize: number, column: Column): number {
  if (!Number.isInteger(householdSize) || householdSize < 1) {
    throw new RangeError(`household size must be a whole number of 1 or more: ${householdSize}`);
  }
  const table = COLUMNS[column];
  if (householdSize <= 8) return table[householdSize - 1]!;
  return table[7]! + (householdSize - 8) * INCREMENT[column];
}

/** "$29,526", "$1,135.50": dollar sign, thousands separators, cents only when present. */
export function formatMoney(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const rest = cents % 100;
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return rest === 0 ? `$${grouped}` : `$${grouped}.${String(rest).padStart(2, "0")}`;
}

const OUTSIDE_LINES = ["Outside our service area.", "We serve ZIP codes 19104, 19139 and 19143 only."];
const BENEFIT_LINES = ["Eligible.", "Reason: someone in the household receives SNAP, TANF, SSI or Medicaid."];

/** The eligibility result the PRD prescribes for a valid form submission. */
export function decide(input: EligibilityInput): Expected {
  const { householdSize, income, frequency, benefits, zip } = input;
  if (!/^\d{5}$/.test(zip)) throw new RangeError(`ZIP code must be 5 digits: ${zip}`);
  if (!Number.isFinite(income) || income < 0) throw new RangeError(`income must be 0 or more: ${income}`);

  if (!(SERVICE_ZIPS as readonly string[]).includes(zip)) {
    return { result: "outside-area", lines: [...OUTSIDE_LINES] };
  }
  if (benefits.length > 0) {
    return { result: "eligible", reason: "benefit", lines: [...BENEFIT_LINES] };
  }

  const column: Column = frequency === "weekly" ? "weekly" : frequency === "monthly" ? "monthly" : "annual";
  const cents = Math.round(income * 100);
  const incomeCounted = frequency === "every-two-weeks" ? cents * 26 : cents;
  const limit = limitFor(householdSize, column);
  const result = incomeCounted <= limit * 100 ? "eligible" : "not-eligible";
  const period = PERIOD[column];
  return {
    result,
    reason: "income",
    column,
    incomeCounted,
    limit,
    lines: [
      result === "eligible" ? "Eligible." : "Not eligible.",
      `Income counted: ${formatMoney(incomeCounted)} per ${period}.`,
      `Limit applied: ${formatMoney(limit * 100)} per ${period} for a household of ${householdSize}.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Booking, proxy and volunteer list.
// ---------------------------------------------------------------------------

export const VISIT_WEEKDAYS = [2, 4, 6] as const; // Tuesday, Thursday, Saturday
export const VISIT_TIMES = ["10:00", "11:00", "12:00", "13:00"] as const;
export const SLOT_CAPACITY = 6;
export const WINDOW_DAYS = 28;

export type VisitTime = (typeof VISIT_TIMES)[number];
/** `date` is YYYY-MM-DD in the pantry's local time. */
export interface Slot {
  date: string;
  time: VisitTime;
}
export interface Visit {
  phone: string; // normalised, 215-555-0101
  slot: Slot;
  householdSize: number;
  proxy: string; // "" when none
  pickedUp: boolean;
}
export interface BookingRequest {
  phone: string;
  slot: Slot | null;
  householdSize: number;
  proxy?: string;
}
export interface BookingResult {
  booked: boolean;
  /** Confirmation lines when booked, otherwise the single PRD message. */
  lines: string[];
  visits: Visit[];
}
export interface VolunteerRow {
  time: VisitTime;
  phone: string;
  householdSize: number;
  proxy: string;
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function parseDate(date: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RangeError(`date must be YYYY-MM-DD: ${date}`);
  return new Date(`${date}T00:00:00Z`);
}

function addDays(date: string, n: number): string {
  const d = parseDate(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "Tuesday, December 1, 2026" */
export function dateLabel(date: string): string {
  const d = parseDate(date);
  return `${WEEKDAY_NAMES[d.getUTCDay()]}, ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** "Tuesday, December 1, 2026 at 10:00", plus " — Full" for a full visit time. */
export function slotLabel(slot: Slot, full = false): string {
  return `${dateLabel(slot.date)} at ${slot.time}${full ? " — Full" : ""}`;
}

/** Every visit time of the 28 days that start with `today`, earliest first. */
export function offeredSlots(today: string): Slot[] {
  const slots: Slot[] = [];
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const date = addDays(today, i);
    if (!(VISIT_WEEKDAYS as readonly number[]).includes(parseDate(date).getUTCDay())) continue;
    for (const time of VISIT_TIMES) slots.push({ date, time });
  }
  return slots;
}

/** 10 digits after dropping spaces, dashes, dots and parentheses -> "215-555-0101"; otherwise null. */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[\s\-.()]/g, "");
  if (!/^\d{10}$/.test(digits)) return null;
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

const sameSlot = (a: Slot, b: Slot) => a.date === b.date && a.time === b.time;

/** True when `offeredSlots(today)` lists this visit time. */
export function isOffered(today: string, slot: Slot): boolean {
  return (
    slot.date >= today &&
    slot.date <= addDays(today, WINDOW_DAYS - 1) &&
    (VISIT_WEEKDAYS as readonly number[]).includes(parseDate(slot.date).getUTCDay()) &&
    (VISIT_TIMES as readonly string[]).includes(slot.time)
  );
}

/** Booking as the PRD prescribes: phone, visit time offered, one visit per calendar month, capacity 6. */
export function bookVisit(visits: Visit[], today: string, req: BookingRequest): BookingResult {
  const refuse = (message: string): BookingResult => ({ booked: false, lines: [message], visits });
  const phone = normalizePhone(req.phone);
  if (phone === null) return refuse("Enter a 10-digit phone number.");
  const slot = req.slot;
  if (slot === null || !isOffered(today, slot)) return refuse("Choose a visit time.");
  const month = slot.date.slice(0, 7);
  if (visits.some((v) => v.phone === phone && v.slot.date.slice(0, 7) === month)) {
    return refuse("This household already has a visit booked in that month.");
  }
  if (visits.filter((v) => sameSlot(v.slot, slot)).length >= SLOT_CAPACITY) {
    return refuse("That visit time is full. Choose another time.");
  }
  const proxy = (req.proxy ?? "").trim();
  const visit: Visit = { phone, slot, householdSize: req.householdSize, proxy, pickedUp: false };
  const lines = ["Visit booked.", `Your visit: ${slotLabel(slot)}.`];
  if (proxy !== "") lines.push(`Proxy: ${proxy}`);
  return { booked: true, lines, visits: [...visits, visit] };
}

/** Today's visits, split into "Expected today" and "Picked up", by visit time (then booking order). */
export function volunteerList(
  visits: Visit[],
  today: string,
): { dateLine: string; expected: VolunteerRow[]; pickedUp: VolunteerRow[] } {
  const todays = visits
    .map((v, i) => ({ v, i }))
    .filter(({ v }) => v.slot.date === today)
    .sort((a, b) => a.v.slot.time.localeCompare(b.v.slot.time) || a.i - b.i)
    .map(({ v }) => v);
  const row = (v: Visit): VolunteerRow => ({
    time: v.slot.time,
    phone: v.phone,
    householdSize: v.householdSize,
    proxy: v.proxy,
  });
  return {
    dateLine: `Visits for ${dateLabel(today)}`,
    expected: todays.filter((v) => !v.pickedUp).map(row),
    pickedUp: todays.filter((v) => v.pickedUp).map(row),
  };
}

/** "Mark picked up" on today's visit of the household with this phone number. */
export function markPickedUp(visits: Visit[], today: string, phone: string): Visit[] {
  const p = normalizePhone(phone);
  return visits.map((v) => (v.phone === p && v.slot.date === today ? { ...v, pickedUp: true } : v));
}

// ---------------------------------------------------------------------------
// Exam run condition: the app under test runs with HOLDBACK_TODAY set to a
// visit day (so the first listed visit time is today and today's volunteer
// list can be filled) on or after the 7th of its month (so the 28-day window
// always reaches a visit day in the next calendar month), and with HOLDBACK_NOW
// set to EXAM_NOW.
// ---------------------------------------------------------------------------

/** HOLDBACK_NOW for every scored run: before the first visit time, so no app hides any of today's times. */
export const EXAM_NOW = "08:00";

export function examTodayAllowed(date: string): boolean {
  const d = parseDate(date);
  return (VISIT_WEEKDAYS as readonly number[]).includes(d.getUTCDay()) && d.getUTCDate() >= 7;
}

/** The first allowed exam day on or after `from` (YYYY-MM-DD). */
export function nextExamToday(from: string): string {
  let d = from;
  while (!examTodayAllowed(d)) d = addDays(d, 1);
  return d;
}

// ---------------------------------------------------------------------------
// The PRD rules the exam depends on. Later PRD changes are append-only (new
// rules after the last numbered rule, a Clarifications section), so the lines
// below must stay byte-identical; PREREGISTERED.md records their sha256.
// Appended text must also not contradict them; no hash can check that.
// ---------------------------------------------------------------------------

export const EXAM_PRD_RULES_TEXT = "1–3, 5–12, 14–29, 32–33, 36, 38, 40–51, 53–60";

export const EXAM_PRD_RULES: readonly number[] = EXAM_PRD_RULES_TEXT.split(", ").flatMap((part) => {
  const [from, to] = part.split("–").map(Number);
  if (to === undefined) return [from!];
  return Array.from({ length: to - from! + 1 }, (_, i) => from! + i);
});

/** Messages-table rows whose message an exam case asserts. */
export const EXAM_PRD_MESSAGES = ["This household already has a visit booked in that month."] as const;

/**
 * The registered part of the PRD: every line before the first "Clarifications" heading and before the first
 * heading that follows the Messages section. Appended Clarifications (even numbered ones) fall outside it.
 */
export function examPrdScope(prd: string): string[] {
  const lines = prd.split(/\r?\n/);
  const messagesAt = lines.indexOf("## Messages");
  if (messagesAt < 0) throw new Error("PRD: Messages section not found");
  const stop = lines.findIndex(
    (l, i) => /^#{1,6} Clarifications\b/.test(l) || (i > messagesAt && /^#{1,6} /.test(l)),
  );
  return stop < 0 ? lines : lines.slice(0, stop);
}

/** The exam-relevant PRD lines: the listed rules, the income limits table and the asserted Messages rows. */
export function examPrdLines(prd: string): string {
  const lines = examPrdScope(prd);
  const rules = lines.filter((l) => {
    const m = /^(\d+)\. /.exec(l);
    return m !== null && EXAM_PRD_RULES.includes(Number(m[1]));
  });
  const start = lines.indexOf("| Household size | Annual | Monthly | Weekly |");
  const end = lines.findIndex((l) => l.startsWith("| Each additional member |"));
  if (start < 0 || end < start) throw new Error("PRD: income limits table not found");
  const messages = EXAM_PRD_MESSAGES.map((msg) => {
    const rows = lines.filter((l) => l.startsWith("| ") && l.endsWith(` | ${msg} |`));
    if (rows.length !== 1) throw new Error(`PRD: Messages row not found once: ${msg}`);
    return rows[0]!;
  });
  return [...rules, ...lines.slice(start, end + 1), ...messages].join("\n") + "\n";
}
