import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ANNUAL,
  EXAM_NOW,
  EXAM_PRD_RULES,
  EXAM_PRD_RULES_TEXT,
  INCREMENT,
  MONTHLY,
  VISIT_TIMES,
  WEEKLY,
  bookVisit,
  decide,
  examPrdLines,
  examTodayAllowed,
  formatMoney,
  limitFor,
  markPickedUp,
  nextExamToday,
  normalizePhone,
  offeredSlots,
  slotLabel,
  volunteerList,
  type EligibilityInput,
  type Slot,
  type Visit,
} from "./reference.js";

// ---------------------------------------------------------------------------
// Published table (pa.gov, TEFAP, "Total Household Income (based on 185% of
// Poverty)", effective July 1, 2026 to June 30, 2027), typed by hand.
// ---------------------------------------------------------------------------

const PA_TABLE: Array<[size: number, annual: number, monthly: number, weekly: number]> = [
  [1, 29_526, 2_461, 568],
  [2, 40_034, 3_337, 770],
  [3, 50_542, 4_212, 972],
  [4, 61_050, 5_088, 1_175],
  [5, 71_558, 5_964, 1_377],
  [6, 82_066, 6_839, 1_579],
  [7, 92_574, 7_715, 1_781],
  [8, 103_082, 8_591, 1_983],
];

describe("published income limits", () => {
  it("match the pa.gov table verbatim", () => {
    expect(ANNUAL).toEqual(PA_TABLE.map((r) => r[1]));
    expect(MONTHLY).toEqual(PA_TABLE.map((r) => r[2]));
    expect(WEEKLY).toEqual(PA_TABLE.map((r) => r[3]));
    expect(INCREMENT).toEqual({ annual: 10_508, monthly: 876, weekly: 203 });
  });

  it("add the per-member increment of the same column above 8 people", () => {
    expect(limitFor(9, "monthly")).toBe(9_467);
    expect(limitFor(10, "annual")).toBe(124_098);
    expect(limitFor(9, "weekly")).toBe(2_186);
    expect(limitFor(12, "annual")).toBe(103_082 + 4 * 10_508);
  });

  it("reject sizes the form would reject", () => {
    expect(() => limitFor(0, "annual")).toThrow();
    expect(() => limitFor(1.5, "annual")).toThrow();
  });
});

describe("formatMoney", () => {
  it("uses a dollar sign, thousands separators and cents only when present", () => {
    expect(formatMoney(2_461_00)).toBe("$2,461");
    expect(formatMoney(124_098_00)).toBe("$124,098");
    expect(formatMoney(568_00)).toBe("$568");
    expect(formatMoney(1_234_50)).toBe("$1,234.50");
    expect(formatMoney(5)).toBe("$0.05");
    expect(formatMoney(0)).toBe("$0");
    expect(formatMoney(1_000_000_00)).toBe("$1,000,000");
  });
});

// ---------------------------------------------------------------------------
// Eligibility exam cases. `lines` is the full result the PRD prescribes;
// `asserted` is what the exam file's last step checks.
// ---------------------------------------------------------------------------

const BENEFIT_LINES = ["Eligible.", "Reason: someone in the household receives SNAP, TANF, SSI or Medicaid."];
const OUTSIDE_LINES = ["Outside our service area.", "We serve ZIP codes 19104, 19139 and 19143 only."];

interface EligibilityCase {
  id: string;
  input: EligibilityInput;
  lines: string[];
  asserted: string[];
}

const inc = (
  householdSize: number,
  income: number,
  frequency: EligibilityInput["frequency"],
  zip: string,
  benefits: EligibilityInput["benefits"] = [],
): EligibilityInput => ({ householdSize, income, frequency, benefits, zip });

const ELIGIBILITY_CASES: EligibilityCase[] = [
  {
    id: "e-01",
    input: inc(1, 2_461, "monthly", "19104"),
    lines: ["Eligible.", "Income counted: $2,461 per month.", "Limit applied: $2,461 per month for a household of 1."],
    asserted: ["Eligible.", "Limit applied: $2,461 per month for a household of 1."],
  },
  {
    id: "e-02",
    input: inc(1, 2_462, "monthly", "19104"),
    lines: ["Not eligible.", "Income counted: $2,462 per month.", "Limit applied: $2,461 per month for a household of 1."],
    asserted: ["Not eligible.", "Limit applied: $2,461 per month for a household of 1."],
  },
  {
    id: "e-03",
    input: inc(1, 568, "weekly", "19139"),
    lines: ["Eligible.", "Income counted: $568 per week.", "Limit applied: $568 per week for a household of 1."],
    asserted: ["Eligible.", "Limit applied: $568 per week for a household of 1."],
  },
  {
    id: "e-04",
    input: inc(1, 569, "weekly", "19139"),
    lines: ["Not eligible.", "Income counted: $569 per week.", "Limit applied: $568 per week for a household of 1."],
    asserted: ["Not eligible.", "Limit applied: $568 per week for a household of 1."],
  },
  {
    id: "e-05",
    input: inc(1, 1_136, "every-two-weeks", "19143"),
    lines: ["Not eligible.", "Income counted: $29,536 per year.", "Limit applied: $29,526 per year for a household of 1."],
    asserted: ["Not eligible.", "Limit applied: $29,526 per year for a household of 1."],
  },
  {
    id: "e-06",
    input: inc(1, 1_135, "every-two-weeks", "19143"),
    lines: ["Eligible.", "Income counted: $29,510 per year.", "Limit applied: $29,526 per year for a household of 1."],
    asserted: ["Eligible.", "Limit applied: $29,526 per year for a household of 1."],
  },
  {
    id: "e-07",
    input: inc(8, 8_591, "monthly", "19104"),
    lines: ["Eligible.", "Income counted: $8,591 per month.", "Limit applied: $8,591 per month for a household of 8."],
    asserted: ["Eligible.", "Limit applied: $8,591 per month for a household of 8."],
  },
  {
    id: "e-08",
    input: inc(9, 9_467, "monthly", "19139"),
    lines: ["Eligible.", "Income counted: $9,467 per month.", "Limit applied: $9,467 per month for a household of 9."],
    asserted: ["Eligible.", "Limit applied: $9,467 per month for a household of 9."],
  },
  {
    id: "e-09",
    input: inc(9, 9_468, "monthly", "19139"),
    lines: ["Not eligible.", "Income counted: $9,468 per month.", "Limit applied: $9,467 per month for a household of 9."],
    asserted: ["Not eligible.", "Limit applied: $9,467 per month for a household of 9."],
  },
  {
    id: "e-10",
    input: inc(10, 124_098, "yearly", "19143"),
    lines: ["Eligible.", "Income counted: $124,098 per year.", "Limit applied: $124,098 per year for a household of 10."],
    asserted: ["Eligible.", "Limit applied: $124,098 per year for a household of 10."],
  },
  {
    id: "e-11",
    input: inc(2, 9_000, "monthly", "19104", ["SSI"]),
    lines: BENEFIT_LINES,
    asserted: BENEFIT_LINES,
  },
  {
    id: "e-12",
    input: inc(3, 10_000, "monthly", "19139", ["Medicaid"]),
    lines: BENEFIT_LINES,
    asserted: BENEFIT_LINES,
  },
  {
    id: "e-13",
    input: inc(1, 1_000, "monthly", "19103"),
    lines: OUTSIDE_LINES,
    asserted: ["Outside our service area."],
  },
  {
    id: "e-19",
    input: inc(1, 500, "monthly", "19102", ["SNAP"]),
    lines: OUTSIDE_LINES,
    asserted: ["Outside our service area."],
  },
  {
    id: "e-20",
    input: inc(4, 1_175, "weekly", "19139"),
    lines: ["Eligible.", "Income counted: $1,175 per week.", "Limit applied: $1,175 per week for a household of 4."],
    asserted: ["Eligible.", "Limit applied: $1,175 per week for a household of 4."],
  },
  {
    id: "e-21",
    input: inc(3, 1_944, "every-two-weeks", "19143"),
    lines: ["Not eligible.", "Income counted: $50,544 per year.", "Limit applied: $50,542 per year for a household of 3."],
    asserted: ["Not eligible.", "Limit applied: $50,542 per year for a household of 3."],
  },
];

describe("eligibility exam cases", () => {
  for (const c of ELIGIBILITY_CASES) {
    it(`${c.id} gives the prescribed result`, () => {
      const got = decide(c.input);
      expect(got.lines).toEqual(c.lines);
      for (const line of c.asserted) expect(got.lines).toContain(line);
    });
  }

  it("out-of-area results carry no eligibility verdict", () => {
    for (const id of ["e-13", "e-19"]) {
      const c = ELIGIBILITY_CASES.find((x) => x.id === id)!;
      const got = decide(c.input);
      expect(got.result).toBe("outside-area");
      expect(got.lines).not.toContain("Eligible.");
      expect(got.lines).not.toContain("Not eligible.");
    }
  });
});

describe("off-by-one neighbours", () => {
  const pairs: Array<[EligibilityInput, "eligible" | "not-eligible"]> = [
    [inc(1, 2_461, "monthly", "19104"), "eligible"],
    [inc(1, 2_462, "monthly", "19104"), "not-eligible"],
    [inc(1, 2_461.01, "monthly", "19104"), "not-eligible"],
    [inc(1, 568, "weekly", "19104"), "eligible"],
    [inc(1, 569, "weekly", "19104"), "not-eligible"],
    [inc(1, 1_135, "every-two-weeks", "19104"), "eligible"],
    [inc(1, 1_136, "every-two-weeks", "19104"), "not-eligible"],
    [inc(1, 29_526, "yearly", "19104"), "eligible"],
    [inc(1, 29_527, "yearly", "19104"), "not-eligible"],
    [inc(8, 8_591, "monthly", "19104"), "eligible"],
    [inc(8, 8_592, "monthly", "19104"), "not-eligible"],
    [inc(9, 9_467, "monthly", "19104"), "eligible"],
    [inc(9, 9_468, "monthly", "19104"), "not-eligible"],
    [inc(10, 124_098, "yearly", "19104"), "eligible"],
    [inc(10, 124_099, "yearly", "19104"), "not-eligible"],
    [inc(4, 1_175, "weekly", "19104"), "eligible"],
    [inc(4, 1_176, "weekly", "19104"), "not-eligible"],
    [inc(3, 1_943, "every-two-weeks", "19104"), "eligible"],
    [inc(3, 1_944, "every-two-weeks", "19104"), "not-eligible"],
  ];
  for (const [input, verdict] of pairs) {
    it(`${input.householdSize}p ${input.income} ${input.frequency} -> ${verdict}`, () => {
      expect(decide(input).result).toBe(verdict);
    });
  }

  it("every published cell is eligible at the limit and not eligible $1 above", () => {
    for (const [size, annual, monthly, weekly] of PA_TABLE) {
      for (const [frequency, limit] of [
        ["yearly", annual],
        ["monthly", monthly],
        ["weekly", weekly],
      ] as const) {
        expect(decide(inc(size, limit, frequency, "19143")).result).toBe("eligible");
        expect(decide(inc(size, limit + 1, frequency, "19143")).result).toBe("not-eligible");
      }
    }
  });

  it("shows cents in the counted income when there are cents", () => {
    expect(decide(inc(1, 2_461.01, "monthly", "19104")).lines[1]).toBe("Income counted: $2,461.01 per month.");
    expect(decide(inc(1, 1_135.62, "every-two-weeks", "19104")).lines[1]).toBe("Income counted: $29,526.12 per year.");
  });
});

describe("rule order", () => {
  it("the ZIP check comes before benefits and income", () => {
    expect(decide(inc(1, 0, "monthly", "19102", ["SNAP", "TANF", "SSI", "Medicaid"])).result).toBe("outside-area");
  });

  it("any one benefit makes a household eligible regardless of income", () => {
    for (const b of ["SNAP", "TANF", "SSI", "Medicaid"] as const) {
      const got = decide(inc(5, 1_000_000, "yearly", "19104", [b]));
      expect(got.result).toBe("eligible");
      expect(got.lines).toEqual(BENEFIT_LINES);
    }
  });

  it("serves exactly 19104, 19139 and 19143", () => {
    for (const zip of ["19104", "19139", "19143"]) expect(decide(inc(1, 0, "monthly", zip)).result).toBe("eligible");
    for (const zip of ["19103", "19102", "19142", "19140", "08104"]) {
      expect(decide(inc(1, 0, "monthly", zip)).result).toBe("outside-area");
    }
  });
});

// Each income case is there because a plausible misreading of the PRD flips it.
describe("what the boundary cases separate", () => {
  it("e-01: monthly income converted to a year (x12) would exceed the annual limit", () => {
    expect(2_461 * 12).toBeGreaterThan(29_526);
  });
  it("e-03: weekly income converted to a year (x52) would exceed the annual limit", () => {
    expect(568 * 52).toBeGreaterThan(29_526);
  });
  it("e-05: every-two-weeks income doubled and compared monthly would pass", () => {
    expect(1_136 * 2).toBeLessThanOrEqual(2_461);
  });
  it("e-08: a 9-person monthly limit worked out from the annual column is lower than the published one", () => {
    expect(Math.ceil((103_082 + 10_508) / 12)).toBeLessThan(limitFor(9, "monthly"));
  });
  it("e-20: a weekly limit worked out as annual / 52 is lower than the published one", () => {
    expect(Math.round(61_050 / 52)).toBeLessThan(limitFor(4, "weekly"));
  });
  it("e-21: every-two-weeks income compared with the monthly column (x26 / 12) would pass", () => {
    expect((1_944 * 26) / 12).toBeLessThanOrEqual(limitFor(3, "monthly"));
    expect(1_944 * 26).toBeGreaterThan(limitFor(3, "annual"));
  });
});

// ---------------------------------------------------------------------------
// Booking, proxy and volunteer list.
// ---------------------------------------------------------------------------

describe("phone numbers", () => {
  it("ignore spaces, dashes, dots and parentheses and need exactly 10 digits", () => {
    expect(normalizePhone("(215) 555-0101")).toBe("215-555-0101");
    expect(normalizePhone("215.555.0101")).toBe("215-555-0101");
    expect(normalizePhone("2155550101")).toBe("215-555-0101");
    expect(normalizePhone("555-0101")).toBeNull();
    expect(normalizePhone("1-215-555-0101")).toBeNull();
    expect(normalizePhone("215-555-010a")).toBeNull();
    expect(normalizePhone("")).toBeNull();
  });
});

describe("visit times", () => {
  it("label a slot like the PRD example", () => {
    expect(slotLabel({ date: "2026-12-01", time: "10:00" })).toBe("Tuesday, December 1, 2026 at 10:00");
    expect(slotLabel({ date: "2026-12-01", time: "10:00" }, true)).toBe("Tuesday, December 1, 2026 at 10:00 — Full");
  });

  it("offer Tue/Thu/Sat 10:00-13:00 for the 28 days that start with today, earliest first", () => {
    const slots = offeredSlots("2026-12-01");
    expect(slots).toHaveLength(48);
    expect(slots[0]).toEqual({ date: "2026-12-01", time: "10:00" });
    expect(slots[1]).toEqual({ date: "2026-12-01", time: "11:00" });
    expect(slots.at(-1)).toEqual({ date: "2026-12-26", time: "13:00" });
    const days = new Set(slots.map((s) => new Date(`${s.date}T00:00:00Z`).getUTCDay()));
    expect([...days].sort()).toEqual([2, 4, 6]);
    for (const s of slots) {
      expect(s.date >= "2026-12-01" && s.date <= "2026-12-28").toBe(true);
    }
  });

  it("start tomorrow-or-later when today is not a visit day", () => {
    expect(offeredSlots("2026-11-15")[0]).toEqual({ date: "2026-11-17", time: "10:00" });
    expect(offeredSlots("2026-11-15").at(-1)).toEqual({ date: "2026-12-12", time: "13:00" });
  });
});

const TODAY = "2026-12-08"; // a Tuesday on/after the 7th
const req = (phone: string, slot: Slot | null, proxy?: string) => ({ phone, slot, householdSize: 1, proxy });

describe("bookVisit", () => {
  it("books and confirms, with the proxy line only when a proxy is named", () => {
    const slot = offeredSlots(TODAY)[0]!;
    const a = bookVisit([], TODAY, req("215-555-0101", slot));
    expect(a.booked).toBe(true);
    expect(a.lines).toEqual(["Visit booked.", "Your visit: Tuesday, December 8, 2026 at 10:00."]);
    const b = bookVisit([], TODAY, req("215-555-0102", slot, "Dana Whitfield"));
    expect(b.lines).toEqual([
      "Visit booked.",
      "Your visit: Tuesday, December 8, 2026 at 10:00.",
      "Proxy: Dana Whitfield",
    ]);
  });

  it("refuses bad input with the PRD messages", () => {
    const slot = offeredSlots(TODAY)[0]!;
    expect(bookVisit([], TODAY, req("555-0101", slot)).lines).toEqual(["Enter a 10-digit phone number."]);
    expect(bookVisit([], TODAY, req("215-555-0101", null)).lines).toEqual(["Choose a visit time."]);
    expect(bookVisit([], TODAY, req("215-555-0101", { date: "2026-12-07", time: "10:00" })).lines).toEqual([
      "Choose a visit time.",
    ]);
  });

  it("allows one visit per household per calendar month, by visit date", () => {
    const slots = offeredSlots(TODAY);
    const first = bookVisit([], TODAY, req("215-555-0101", slots[0]!));
    const again = bookVisit(first.visits, TODAY, req("(215) 555-0101", slots[5]!));
    expect(again.booked).toBe(false);
    expect(again.lines).toEqual(["This household already has a visit booked in that month."]);
    const jan = slots.find((s) => s.date.startsWith("2027-01"))!;
    expect(bookVisit(first.visits, TODAY, req("215-555-0101", jan)).booked).toBe(true);
  });

  it("caps a visit time at 6 households and marks it Full", () => {
    const slot = offeredSlots(TODAY)[2]!;
    let visits: Visit[] = [];
    for (let i = 1; i <= 6; i++) {
      const r = bookVisit(visits, TODAY, req(`215-555-02${String(i).padStart(2, "0")}`, slot));
      expect(r.booked).toBe(true);
      visits = r.visits;
    }
    const seventh = bookVisit(visits, TODAY, req("215-555-0207", slot));
    expect(seventh.booked).toBe(false);
    expect(seventh.lines).toEqual(["That visit time is full. Choose another time."]);
  });
});

describe("volunteer list", () => {
  it("shows today's visits by time, with proxy, and moves a pickup to Picked up", () => {
    const slots = offeredSlots(TODAY);
    let visits: Visit[] = [];
    visits = bookVisit(visits, TODAY, req("215-555-0302", slots[1]!)).visits;
    visits = bookVisit(visits, TODAY, req("215-555-0301", slots[0]!, "Dana Whitfield")).visits;
    visits = bookVisit(visits, TODAY, req("215-555-0303", slots[4]!)).visits; // another day
    const before = volunteerList(visits, TODAY);
    expect(before.dateLine).toBe("Visits for Tuesday, December 8, 2026");
    expect(before.expected).toEqual([
      { time: "10:00", phone: "215-555-0301", householdSize: 1, proxy: "Dana Whitfield" },
      { time: "11:00", phone: "215-555-0302", householdSize: 1, proxy: "" },
    ]);
    expect(before.pickedUp).toEqual([]);
    const after = volunteerList(markPickedUp(visits, TODAY, "215-555-0301"), TODAY);
    expect(after.expected.map((r) => r.phone)).toEqual(["215-555-0302"]);
    expect(after.pickedUp.map((r) => r.phone)).toEqual(["215-555-0301"]);
  });
});

// ---------------------------------------------------------------------------
// Booking exam cases, run the way the exam runs them: one app, one fresh
// database, the five booking tests in any order, HOLDBACK_TODAY set to an
// allowed exam day. Every allowed day over two years and every order must give
// the expected outcome.
// ---------------------------------------------------------------------------

type BookingCase = (visits: Visit[], today: string) => Visit[];

const ELIGIBLE_SIZE = 1;
const book = (visits: Visit[], today: string, phone: string, slot: Slot, proxy?: string) =>
  bookVisit(visits, today, { phone, slot, householdSize: ELIGIBLE_SIZE, proxy });

const BOOKING_CASES: Record<string, BookingCase> = {
  // e-14: second booking in the same calendar month is refused.
  "e-14": (visits, today) => {
    const slots = offeredSlots(today);
    const a = book(visits, today, "215-555-0114", slots[0]!);
    expect(a.booked).toBe(true);
    const b = book(a.visits, today, "215-555-0114", slots[1]!);
    expect(b.booked).toBe(false);
    expect(b.lines).toEqual(["This household already has a visit booked in that month."]);
    return b.visits;
  },
  // e-15: a booking in the next calendar month is allowed.
  "e-15": (visits, today) => {
    const slots = offeredSlots(today);
    const a = book(visits, today, "215-555-0115", slots[0]!);
    expect(a.booked).toBe(true);
    const nextMonth = slots.find((s) => s.date.slice(0, 7) > slots[0]!.date.slice(0, 7))!;
    expect(nextMonth).toBeDefined();
    const b = book(a.visits, today, "215-555-0115", nextMonth);
    expect(b.booked).toBe(true);
    expect(b.lines[0]).toBe("Visit booked.");
    return b.visits;
  },
  // e-16: six households fill the latest visit time; the seventh sees it Full and cannot book it.
  "e-16": (visits, today) => {
    const last = offeredSlots(today).at(-1)!;
    let v = visits;
    for (let i = 1; i <= 6; i++) {
      const r = book(v, today, `215-555-016${i}`, last);
      expect(r.booked).toBe(true);
      v = r.visits;
    }
    expect(offeredSlots(today).at(-1)).toEqual(last);
    expect(slotLabel(last, isFull(v, last))).toMatch(/ — Full$/);
    const seventh = book(v, today, "215-555-0167", last);
    expect(seventh.booked).toBe(false);
    expect(seventh.lines.some((l) => l.startsWith("Your visit:"))).toBe(false);
    return seventh.visits;
  },
  // e-22: five households book the second-latest visit time; the sixth still gets it.
  "e-22": (visits, today) => {
    const secondLatest = offeredSlots(today).at(-2)!;
    let v = visits;
    for (let i = 1; i <= 5; i++) {
      const r = book(v, today, `215-555-022${i}`, secondLatest);
      expect(r.booked).toBe(true);
      v = r.visits;
    }
    expect(isFull(v, secondLatest)).toBe(false);
    const sixth = book(v, today, "215-555-0226", secondLatest);
    expect(sixth.booked).toBe(true);
    expect(sixth.lines[0]).toBe("Visit booked.");
    return sixth.visits;
  },
  // e-17: the proxy's name is on today's volunteer list.
  "e-17": (visits, today) => {
    const r = book(visits, today, "215-555-0117", offeredSlots(today)[0]!, "Dana Whitfield");
    expect(r.booked).toBe(true);
    const row = volunteerList(r.visits, today).expected.find((x) => x.phone === "215-555-0117");
    expect(row?.proxy).toBe("Dana Whitfield");
    return r.visits;
  },
  // e-18: "Mark picked up" moves the visit to Picked up.
  "e-18": (visits, today) => {
    const r = book(visits, today, "215-555-0118", offeredSlots(today)[0]!);
    expect(r.booked).toBe(true);
    expect(volunteerList(r.visits, today).expected.map((x) => x.phone)).toContain("215-555-0118");
    const after = markPickedUp(r.visits, today, "215-555-0118");
    const list = volunteerList(after, today);
    expect(list.pickedUp.map((x) => x.phone)).toContain("215-555-0118");
    expect(list.expected.map((x) => x.phone)).not.toContain("215-555-0118");
    return after;
  },
};

function isFull(visits: Visit[], slot: Slot): boolean {
  return visits.filter((v) => v.slot.date === slot.date && v.slot.time === slot.time).length >= 6;
}

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

describe("exam run condition (HOLDBACK_TODAY)", () => {
  it("allows a Tuesday, Thursday or Saturday on or after the 7th of its month", () => {
    expect(examTodayAllowed("2026-12-08")).toBe(true); // Tue 8th
    expect(examTodayAllowed("2026-12-07")).toBe(false); // Mon
    expect(examTodayAllowed("2026-12-05")).toBe(false); // Sat 5th
    expect(examTodayAllowed("2026-12-31")).toBe(true); // Thu 31st
    expect(nextExamToday("2026-11-15")).toBe("2026-11-17");
    expect(nextExamToday("2026-12-01")).toBe("2026-12-08");
  });

  it("is needed: on Tuesday, December 1, 2026 no visit time falls in the next month", () => {
    const slots = offeredSlots("2026-12-01");
    expect(slots.some((s) => s.date.startsWith("2027-01"))).toBe(false);
  });

  it("pins HOLDBACK_NOW before the first visit time, so no app hides any of today's times", () => {
    expect(EXAM_NOW).toBe("08:00");
    expect(EXAM_NOW < VISIT_TIMES[0]).toBe(true);
  });
});

describe("booking exam cases", () => {
  const allowedDays: string[] = [];
  for (let d = "2026-07-01"; d <= "2028-06-30"; d = addDays(d, 1)) if (examTodayAllowed(d)) allowedDays.push(d);
  const orders = permutations(Object.keys(BOOKING_CASES));

  it("covers enough allowed days and every order", () => {
    expect(allowedDays.length).toBe(249);
    expect(orders).toHaveLength(720);
  });

  const runAll = (today: string, order: string[]) => {
    let visits: Visit[] = [];
    try {
      for (const id of order) visits = BOOKING_CASES[id]!(visits, today);
    } catch (err) {
      throw new Error(`today ${today}, order ${order.join(" ")}: ${(err as Error).message}`);
    }
  };

  it("give the expected outcome on every allowed day, on one shared database", () => {
    for (const today of allowedDays) {
      expect(offeredSlots(today)[0]).toEqual({ date: today, time: "10:00" });
      runAll(today, orders[0]!);
      runAll(today, orders.at(-1)!);
    }
  });

  it("give the expected outcome in every order (28-, 30- and 31-day months, and a month-end day)", () => {
    const days = ["2027-02-09", "2026-11-07", "2026-12-08", "2026-12-31"];
    for (const today of days) expect(allowedDays).toContain(today);
    for (const today of days) for (const order of orders) runAll(today, order);
  });

  it("give the expected outcome on the first allowed day of each month, in rotated orders", () => {
    const firstOfMonth = allowedDays.filter((d, i) => i === 0 || allowedDays[i - 1]!.slice(0, 7) !== d.slice(0, 7));
    expect(firstOfMonth).toHaveLength(24);
    const ids = Object.keys(BOOKING_CASES);
    for (const today of firstOfMonth) {
      for (let k = 0; k < ids.length; k++) runAll(today, [...ids.slice(k), ...ids.slice(0, k)]);
    }
  });
});

// ---------------------------------------------------------------------------
// The exam files, the PRD and PREREGISTERED.md agree with this reference.
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAM_DIR = join(HERE, "exam");
const SPEC_DIR = join(HERE, "..", "examples", "pantry-spec");
const read = (p: string) => readFileSync(p, "utf8");

const FREQUENCY_LABEL = {
  weekly: "Weekly",
  "every-two-weeks": "Every two weeks",
  monthly: "Monthly",
  yearly: "Yearly",
} as const;
const BENEFITS = ["SNAP", "TANF", "SSI", "Medicaid"] as const;

const quotedList = (xs: readonly string[]) => {
  const q = xs.map((x) => `"${x}"`);
  return q.length === 1 ? q[0]! : `${q.slice(0, -1).join(", ")} and ${q.at(-1)}`;
};

/** The exact wording every exam file uses to fill in the eligibility form. */
function fillPhrase(i: EligibilityInput): string {
  const ticked = BENEFITS.filter((b) => i.benefits.includes(b));
  const unticked = BENEFITS.filter((b) => !i.benefits.includes(b));
  const benefitPart =
    ticked.length === 0
      ? `leave ${quotedList(unticked)} unticked`
      : `tick ${quotedList(ticked)}, leave ${quotedList(unticked)} unticked`;
  return (
    `set "Household size" to ${i.householdSize}, "Household income ($)" to ${i.income} and ` +
    `"How often is this income received?" to "${FREQUENCY_LABEL[i.frequency]}", ${benefitPart}, ` +
    `set "ZIP code" to ${i.zip}, and choose "Check eligibility"`
  );
}

/** Every booking in the exam goes through this eligible household. */
const BOOKING_HOUSEHOLD = inc(1, 1_000, "monthly", "19104");

interface ExamFile {
  name: string;
  text: string;
  frontmatter: string;
  title: string;
  steps: string[];
}

function parseExam(name: string): ExamFile {
  const text = read(join(EXAM_DIR, name));
  const m = /^---\n([\s\S]*?)\n---\n# (.+)\n\n> .+\n\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${name}: not "frontmatter, # title, > summary, steps"`);
  const parts = m[3]!.split(/^## Step (\d+)\n\n/m);
  const steps: string[] = [];
  for (let k = 1; k < parts.length; k += 2) {
    expect(Number(parts[k]), `${name} step numbering`).toBe(steps.length + 1);
    steps.push(parts[k + 1]!.trim());
  }
  return { name, text, frontmatter: m[1]!, title: m[2]!, steps };
}

const quoted = (s: string) => [...s.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);

describe("exam files", () => {
  const names = () =>
    readdirSync(EXAM_DIR)
      .filter((f) => f.endsWith(".md"))
      .sort();
  const caseIds = [...ELIGIBILITY_CASES.map((c) => c.id), ...Object.keys(BOOKING_CASES)].sort();
  const fileFor = (id: string) => {
    const hits = names().filter((n) => n.startsWith(`${id}-`));
    expect(hits, id).toHaveLength(1);
    return parseExam(hits[0]!);
  };

  it("are 18 to 24 *_test.md files, one per reference case, ids e-01 upwards", () => {
    const files = names();
    expect(files.length).toBeGreaterThanOrEqual(18);
    expect(files.length).toBeLessThanOrEqual(24);
    for (const f of files) expect(f).toMatch(/^e-\d{2}-[a-z0-9-]+_test\.md$/);
    const ids = files.map((f) => f.slice(0, 4));
    expect(ids).toEqual(caseIds);
    expect(ids).toEqual(ids.map((_, i) => `e-${String(i + 1).padStart(2, "0")}`));
  });

  it("carry the exam id in tags (a key Kane accepts), never assurance frontmatter", () => {
    for (const f of names()) {
      const e = parseExam(f);
      expect(e.frontmatter).toBe(`tags: [exam, ${f.slice(0, 4)}]`);
      expect(e.text).not.toMatch(/assurance|@verifies/);
    }
  });

  it("start at {{start_url}} and assert only in the last step", () => {
    for (const f of names()) {
      const e = parseExam(f);
      expect(e.steps.length, f).toBeGreaterThanOrEqual(2);
      expect(e.steps[0], f).toMatch(/^At \{\{start_url\}\}, /);
      e.steps.slice(0, -1).forEach((s) => expect(s, f).not.toMatch(/\bassert/));
      expect(e.steps.at(-1)!.match(/\bassert\b/g), f).toHaveLength(1);
    }
  });

  it("quote only copy the PRD fixes (or the case's own expected result lines)", () => {
    const prd = read(join(SPEC_DIR, "PRD.md"));
    for (const id of caseIds) {
      const e = fileFor(id);
      const own = ELIGIBILITY_CASES.find((c) => c.id === id)?.lines ?? [];
      for (const q of quoted(e.steps.join("\n"))) {
        if (!own.includes(q)) expect(prd, `${e.name}: "${q}"`).toContain(q);
      }
    }
  });

  it("fill in each eligibility case's input and assert its expected lines", () => {
    for (const c of ELIGIBILITY_CASES) {
      const e = fileFor(c.id);
      expect(e.steps).toHaveLength(2);
      expect(e.steps[0]).toBe('At {{start_url}}, open the "Food pantry eligibility check" page.');
      const last = e.steps[1]!;
      expect(last).toContain(`On the "Food pantry eligibility check" page, ${fillPhrase(c.input)}; then assert `);
      for (const line of c.asserted) expect(last).toContain(`"${line}"`);
      const got = decide(c.input);
      if (got.result === "outside-area") {
        expect(last).toMatch(/ and shows neither "Eligible\." nor "Not eligible\."$/);
      } else if (got.lines[0] === "Eligible.") {
        // "Eligible." reads like part of "Not eligible.": every Eligible case also rules that out.
        expect(last, c.id).toMatch(/ and does not say "Not eligible\."$/);
      }
    }
  });

  const bookingStep = (phone: string, choice: string, proxy?: string, submit = 'and choose "Book visit"') =>
    `At {{start_url}}, on the "Food pantry eligibility check" page, ${fillPhrase(BOOKING_HOUSEHOLD)}; ` +
    `then choose "Book a visit", and on the "Book a visit" page enter ${phone} in "Phone number", ${choice}, ` +
    (proxy ? `enter ${proxy} in "Proxy name (optional)"` : `leave "Proxy name (optional)" empty`) +
    `, ${submit}`;
  const pick = (which: string) => `choose the ${which} Tuesday, Thursday or Saturday visit time listed in "Visit time"`;
  const EARLIEST = pick("earliest");
  const LATEST = pick("latest");
  const SECOND_LATEST = pick("second-latest");

  it("e-14 books the earliest visit time, then is refused the second-earliest one in the same month", () => {
    expect(fileFor("e-14").steps).toEqual([
      `${bookingStep("215-555-0114", EARLIEST)}.`,
      `${bookingStep("215-555-0114", pick("second-earliest"))}; then assert the page says ` +
        '"This household already has a visit booked in that month." and does not show "Your visit:"',
    ]);
  });

  it("e-15 books the earliest visit time, then one in the next calendar month", () => {
    const nextMonth =
      'in "Visit time" choose the earliest Tuesday, Thursday or Saturday visit time listed whose date is in the ' +
      "calendar month after the month of the earliest one listed";
    expect(fileFor("e-15").steps).toEqual([
      `${bookingStep("215-555-0115", EARLIEST)}.`,
      `${bookingStep("215-555-0115", nextMonth)}; then assert the page says "Visit booked."`,
    ]);
  });

  it("e-16 fills the latest visit time with six households; the seventh finds it Full", () => {
    const setup = [1, 2, 3, 4, 5, 6].map((i) => `${bookingStep(`215-555-016${i}`, LATEST)}.`);
    const seventh = bookingStep(
      "215-555-0167",
      'try to choose the latest Tuesday, Thursday or Saturday visit time listed in "Visit time"',
      undefined,
      'and only if that visit time could be chosen, choose "Book visit"',
    );
    expect(fileFor("e-16").steps).toEqual([
      ...setup,
      `${seventh}; then assert the latest visit time listed in "Visit time" is marked "Full" and the page does not ` +
        'show "Your visit:"',
    ]);
  });

  it("e-17 names a proxy and finds it on the volunteer list", () => {
    expect(fileFor("e-17").steps).toEqual([
      `${bookingStep("215-555-0117", EARLIEST, "Dana Whitfield")}.`,
      'Choose the "Volunteer list" link at the top of the page; then assert that under "Expected today" the visit ' +
        'with phone number 215-555-0117 shows Dana Whitfield in the "Proxy" column.',
    ]);
  });

  it("e-18 marks a visit picked up and finds it under Picked up after a reload", () => {
    expect(fileFor("e-18").steps).toEqual([
      `${bookingStep("215-555-0118", EARLIEST)}.`,
      'Choose the "Volunteer list" link at the top of the page, and under "Expected today" choose "Mark picked up" ' +
        "on the visit with phone number 215-555-0118.",
      'Reload the page; then assert the visit with phone number 215-555-0118 is listed under "Picked up" and is ' +
        'no longer listed under "Expected today".',
    ]);
  });

  it("e-22 books five households into the second-latest visit time; the sixth still gets it", () => {
    const setup = [1, 2, 3, 4, 5].map((i) => `${bookingStep(`215-555-022${i}`, SECOND_LATEST)}.`);
    expect(fileFor("e-22").steps).toEqual([
      ...setup,
      `${bookingStep("215-555-0226", SECOND_LATEST)}; then assert the page says "Visit booked."`,
    ]);
  });

  it("never pick a visit time by bare list position", () => {
    for (const f of names()) expect(read(join(EXAM_DIR, f)), f).not.toMatch(/(first|second|last) option listed/);
  });

  it("use phone numbers no other exam case uses", () => {
    const seen = new Map<string, string>();
    for (const f of names()) {
      for (const phone of new Set(read(join(EXAM_DIR, f)).match(/215-555-\d{4}/g) ?? [])) {
        expect(seen.get(phone), `${phone} in ${f}`).toBeUndefined();
        seen.set(phone, f);
      }
    }
  });
});

describe("PRD", () => {
  const prd = () => read(join(SPEC_DIR, "PRD.md"));

  it("carries the pa.gov table verbatim with its title, dates and source", () => {
    const text = prd();
    expect(text).toContain("Total Household Income (based on 185% of Poverty)");
    expect(text).toContain("effective July 1, 2026 to June 30, 2027");
    expect(text).toContain(
      "https://www.pa.gov/en/agencies/pda/food/food-assistance/the-emergency-food-assistance-program.html",
    );
    expect(text).toContain("| Household size | Annual | Monthly | Weekly |");
    for (const [size, a, m, w] of PA_TABLE) {
      const row = `| ${size} | ${formatMoney(a * 100)} | ${formatMoney(m * 100)} | ${formatMoney(w * 100)} |`;
      expect(text).toContain(row);
    }
    expect(text).toContain("| Each additional member | +$10,508 | +$876 | +$203 |");
  });

  it("states its examples exactly as the reference computes them", () => {
    const text = prd();
    for (const input of [inc(2, 3_400, "monthly", "19139"), inc(4, 1_500, "every-two-weeks", "19104")]) {
      for (const line of decide(input).lines) expect(text).toContain(`"${line}"`);
    }
    expect(text).toContain(`"${slotLabel({ date: "2026-12-01", time: "10:00" })}"`);
    expect(text).toContain(`"${slotLabel({ date: "2026-12-01", time: "10:00" }, true)}"`);
    expect(volunteerList([], "2026-12-01").dateLine).toBe("Visits for Tuesday, December 1, 2026");
    expect(text).toContain('"Visits for {today\'s date}"');
  });

  it("fixes every message the reference produces", () => {
    const text = prd();
    const messages = [
      ...BENEFIT_LINES,
      ...OUTSIDE_LINES,
      "Visit booked.",
      "Enter a 10-digit phone number.",
      "Choose a visit time.",
      "This household already has a visit booked in that month.",
      "That visit time is full. Choose another time.",
    ];
    for (const m of messages) expect(text).toContain(m);
  });

  it("does not give away any exam case's expected income or limit line", () => {
    const text = prd();
    for (const c of ELIGIBILITY_CASES) {
      for (const line of c.lines.filter((l) => l.startsWith("Limit applied:") || l.startsWith("Income counted:"))) {
        expect(text).not.toContain(line);
      }
    }
  });
});

describe("plain product voice", () => {
  it("PRD, STACK and exam never mention assistants or test tooling", () => {
    const docs = [join(SPEC_DIR, "PRD.md"), join(SPEC_DIR, "STACK.md")];
    for (const f of readdirSync(EXAM_DIR)) docs.push(join(EXAM_DIR, f));
    for (const f of docs) {
      expect(read(f), f).not.toMatch(/\b(AI|Claude|Anthropic|LLM|GPT|Copilot|assistant|agent|Kane)\b/i);
    }
    expect(read(join(SPEC_DIR, "PRD.md"))).not.toMatch(/\b(test|tests|exam|HOLDBACK_TODAY)\b/i);
  });

  it("STACK fixes runtime, server, storage, start command and today override", () => {
    const stack = read(join(SPEC_DIR, "STACK.md"));
    const required = ["Node.js 24", "Hono", "node:sqlite", "DATA_DIR", "./data", "npm start", "PORT", "3100"];
    for (const s of [...required, "HOLDBACK_TODAY", "HOLDBACK_NOW", "HH:MM"]) expect(stack).toContain(s);
  });
});

describe("PRD rules the exam depends on", () => {
  const prd = () => read(join(SPEC_DIR, "PRD.md"));

  it("are the listed rule numbers, each present exactly once", () => {
    expect(EXAM_PRD_RULES.slice(0, 4)).toEqual([1, 2, 3, 5]);
    expect(EXAM_PRD_RULES).not.toContain(4);
    expect(EXAM_PRD_RULES).not.toContain(13);
    expect(EXAM_PRD_RULES.at(-1)).toBe(60);
    const lines = prd().split(/\r?\n/);
    for (const n of EXAM_PRD_RULES) expect(lines.filter((l) => l.startsWith(`${n}. `)), `rule ${n}`).toHaveLength(1);
  });

  it("cover every PRD string the exam quotes", () => {
    const used = examPrdLines(prd());
    for (const f of readdirSync(EXAM_DIR).filter((x) => x.endsWith(".md"))) {
      const e = parseExam(f);
      const own = ELIGIBILITY_CASES.find((c) => c.id === f.slice(0, 4))?.lines ?? [];
      for (const q of quoted(e.steps.join("\n"))) {
        if (!own.includes(q)) expect(used, `${f}: "${q}"`).toContain(q);
      }
    }
  });

  it("include the income limits table and the one Messages row the exam asserts", () => {
    const used = examPrdLines(prd());
    expect(used).toContain("| Each additional member | +$10,508 | +$876 | +$203 |");
    expect(used).toContain("| This household already has a visit booked in that month. |");
    expect(used).not.toContain("Enter a 10-digit phone number.");
  });
});

describe("PREREGISTERED.md", () => {
  const pre = () => read(join(HERE, "PREREGISTERED.md"));
  const sha = (x: string | Buffer) => createHash("sha256").update(x).digest("hex");

  it("lists the sha256 of every exam file and nothing else", () => {
    const text = pre();
    const rows = [...text.matchAll(/^\| `exam\/([^`]+)` \| `([0-9a-f]{64})` \|$/gm)].map((m) => [m[1]!, m[2]!]);
    const files = readdirSync(EXAM_DIR)
      .filter((f) => f.endsWith(".md"))
      .sort();
    expect(rows.map((r) => r[0])).toEqual(files);
    for (const [file, hash] of rows) {
      expect(sha(readFileSync(join(EXAM_DIR, file!))), file).toBe(hash);
    }
  });

  it("records the PRD rules the exam depends on and their sha256, which later appends must not change", () => {
    const text = pre();
    expect(text).toContain(`PRD rules ${EXAM_PRD_RULES_TEXT}`);
    const m = /^\| PRD lines the exam depends on \(`examPrdLines\(\)`\) \| `([0-9a-f]{64})` \|$/m.exec(text);
    expect(m).not.toBeNull();
    expect(sha(examPrdLines(read(join(SPEC_DIR, "PRD.md"))))).toBe(m![1]);
  });

  it("records PRD.md and STACK.md hashes at registration", () => {
    const text = pre();
    expect(text).toMatch(/^\| `examples\/pantry-spec\/PRD\.md` \| `[0-9a-f]{64}` \|$/m);
    expect(text).toMatch(/^\| `examples\/pantry-spec\/STACK\.md` \| `[0-9a-f]{64}` \|$/m);
  });

  it("pins the run conditions and the expectation", () => {
    const text = pre();
    const n = readdirSync(EXAM_DIR).filter((f) => f.endsWith(".md")).length;
    for (const s of [
      "`HOLDBACK_TODAY` = `nextExamToday()`",
      `\`HOLDBACK_NOW\` = \`${EXAM_NOW}\``,
      "fresh, empty `DATA_DIR`",
      "one attempt per case",
      `out of ${n}`,
      "without web access",
      "Holdback (C) scores ≥ the agent alone (A) and ≥ the agent with self-written Kane checks (B) on this exam; " +
        "A and B each stop claiming done with at least one exam case failing.",
    ]) {
      expect(text).toContain(s);
    }
  });
});
