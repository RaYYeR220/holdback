import type { AcNode, GapNode, PendingQuestion, TestNode } from "../kane/assurance.js";
import type { BugVerdict, TestRunResult } from "../kane/testmd.js";

export type RunKind = "build" | "falsify" | "exam" | "bisect";

export type LedgerEvent = { at: string } & (
  | { t: "spec.ingested"; sources: { id: string; cid: string; status?: string; file?: string }[]; credits?: number }
  | { t: "spec.paused"; sid: string; questions: PendingQuestion[]; credits?: number }
  | { t: "spec.answered"; sid: string; answers: Record<string, string>; credits?: number }
  | { t: "spec.approved"; refs: string[]; rejected?: string[] }
  | { t: "design"; useCase: string; acs: AcNode[]; tests: TestNode[]; gaps: GapNode[]; credits: number }
  | { t: "seal"; manifest: Record<string, string> }
  | { t: "turn.start"; n: number; owed: string[] }
  | {
      t: "turn.end";
      n: number;
      commit: string;
      filesChanged: string[];
      durationMs: number;
      appUp: boolean;
      agentExit: number;
    }
  | { t: "run"; kind: RunKind; turn?: number; mutantId?: string; result: TestRunResult }
  | {
      t: "mutant";
      id: string;
      ac: string;
      patch: string;
      model: string;
      usd: number;
      verdict: "killed" | "survived" | "survived-by-heal" | "invalid";
      note?: string;
    }
  /** A falsify-stage re-design that was rolled back (nothing sealed); its Kane credits still count. */
  | { t: "redesign.dropped"; useCases: string[]; detail: string; credits: number }
  | { t: "drift"; rows: { kind: string; ref: string; why: string }[]; applied: boolean; credits?: number }
  | { t: "regression"; ac: string; turn: number; blamedTurn?: number; blamedCommit?: string; detail?: string }
  | { t: "tamper"; detail: string }
  /**
   * Baseline after a Kane batch (app stopped): digest of Kane's own `output-*` run recordings and the
   * app repo's git config hash. The next build loop holds the disk to the latest one at start.
   */
  | { t: "recordings"; digest: string; gitConfig: string }
  /**
   * One metered Kane batch (`KaneMeter`): `kane-cli balance` before minus after (null when it could
   * not be read, `error` says why), and the per-run credits the events logged in that batch carry.
   */
  | { t: "credits"; source: string; delta: number | null; perRunSum: number; error?: string }
);

export type AcStatus = "owed" | "passing" | "proved" | "vacuous" | "regressed" | "needs-spec";

export type AcState = {
  id: string;
  text: string;
  useCase: string;
  cites: AcNode["cites"];
  tests: string[];
  status: AcStatus;
  lastFailure?: {
    test: string;
    step?: number;
    stepText?: string;
    verdict?: BugVerdict;
    screenshot?: string;
    turn?: number;
    reason?: string;
  };
};

export type LedgerState = {
  acs: Record<string, AcState>;
  turn: number;
  /** Kane credits as Kane reported them per run (design, run, spec and drift events): the per-run sum. */
  credits: number;
  /**
   * Kane credits by `kane-cli balance`: each metered batch's balance drop (its per-run sum when the
   * balance could not be read), plus per-run credits logged outside any metered batch.
   */
  kaneCredits: number;
  /** Metered batches whose balance could not be read (their per-run sum stands in). */
  kaneUnmeasured: number;
  breakerUsd: number;
  runs: number;
  mutants: { killed: number; survived: number; invalid: number };
  /**
   * Tests whose latest build run proved nothing (Kane's environment or automation, a timeout, a
   * crash): the criteria they verify kept their status. For the human, never the agent's brief.
   */
  inconclusive: { test: string; turn?: number; reason: string }[];
  /** A `tamper` event with no later `seal`: nothing verified since can be trusted until a human re-seals. */
  tampered: boolean;
};
