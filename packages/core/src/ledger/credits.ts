import type { LedgerEvent } from "./types.js";
import type { EventBody } from "./vouched.js";

/** Kane's credit balance (`kane-cli balance`); injected so tests stay offline. */
export type BalanceReader = () => Promise<number>;

type CreditsEvent = Extract<EventBody, { t: "credits" }>;

const round = (n: number) => Math.round(n * 1e4) / 1e4;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The Kane credits one ledger event books as Kane reported them per run (0 for every other event). */
export function eventCredits(e: EventBody | LedgerEvent): number {
  switch (e.t) {
    case "design":
      return e.credits;
    case "run":
      return e.result.credits;
    case "spec.ingested":
    case "spec.paused":
    case "spec.answered":
    case "redesign.dropped":
    case "drift":
      return typeof e.credits === "number" ? e.credits : 0;
    default:
      return 0;
  }
}

async function read(balance: BalanceReader): Promise<number | { error: string }> {
  try {
    const n = await balance();
    return Number.isFinite(n) ? n : { error: `balance: not a number (${String(n)})` };
  } catch (e) {
    return { error: errText(e) };
  }
}

/**
 * Meters Kane batches by the balance itself: `batch` reads `kane-cli balance` before and after its
 * body and logs a `credits` event with the drop and the per-run credits of every event the caller
 * logged meanwhile (each one goes through `add`). The per-run figures alone under-count: a run killed
 * mid-step reports nothing for the step it was on. A balance that cannot be read, or that rose (a
 * top-up), logs `delta: null` with the reason and never fails the batch. Without a reader nothing is
 * metered and nothing is logged. Batches do not nest: an inner one runs unmetered inside the outer.
 */
export class KaneMeter {
  private open: { source: string; before: number | { error: string }; perRun: number } | undefined;

  constructor(
    private readonly balance: BalanceReader | undefined,
    /** Appends the `credits` event (not through `add`). */
    private readonly log: (e: CreditsEvent) => Promise<void>,
  ) {}

  /** Every event the caller logs: tallied while a batch is open. */
  add(e: EventBody | LedgerEvent): void {
    if (this.open) this.open.perRun += eventCredits(e);
  }

  async batch<T>(source: string, body: () => Promise<T>): Promise<T> {
    if (!this.balance || this.open) return body();
    this.open = { source, before: await read(this.balance), perRun: 0 };
    let done = false;
    try {
      const out = await body();
      done = true;
      return out;
    } finally {
      const { before, perRun } = this.open;
      this.open = undefined;
      const after = await read(this.balance);
      const e: CreditsEvent = { t: "credits", source, delta: null, perRunSum: round(perRun) };
      if (typeof before !== "number") e.error = before.error;
      else if (typeof after !== "number") e.error = after.error;
      else if (before < after) e.error = `the balance rose during the batch (${before} -> ${after}): a top-up?`;
      else e.delta = round(before - after);
      // a body that threw is reported as it threw: the event is then best effort
      if (done) await this.log(e);
      else await this.log(e).catch(() => {});
    }
  }
}
