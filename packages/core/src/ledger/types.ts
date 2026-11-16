import type { AcNode, GapNode, PendingQuestion, TestNode } from "../kane/assurance.js";
import type { BugVerdict, TestRunResult } from "../kane/testmd.js";
import type { Slip } from "../breaker/mutate.js";

/**
 * `build`: a check of an agent turn's build (`turn`: that turn). `replay`: falsify's closing replay of
 * the real build, after its planted bugs (`turn`: the turn whose code it replayed). Both decide a
 * criterion's status (`decidesStatus`); `falsify` (a planted bug), `exam` and `bisect` runs do not.
 */
export type RunKind = "build" | "falsify" | "exam" | "bisect" | "replay";

export type LedgerEvent = { at: string } & (
  | { t: "spec.ingested"; sources: { id: string; cid: string; status?: string; file?: string }[]; credits?: number }
  | { t: "spec.paused"; sid: string; questions: PendingQuestion[]; credits?: number }
  | { t: "spec.answered"; sid: string; answers: Record<string, string>; credits?: number }
  | { t: "spec.approved"; refs: string[]; rejected?: string[] }
  /**
   * A use case's criteria and tests as Kane designed them. `rejected`: the ids among them a human
   * turned down when approving the design (a rejected criterion is never owed, a rejected test never
   * runs). A later design of the use case replaces it whole. `notes`: why a criterion is as it is,
   * by id (one an evolve left without a test, say), for the human.
   */
  | { t: "design"; useCase: string; acs: AcNode[]; tests: TestNode[]; gaps: GapNode[]; credits: number; rejected?: string[]; notes?: Record<string, string> }
  /** The spec stage's extraction finished for the spec files and links as they hash to `hash`: a resumed stage need not ingest again. */
  | { t: "spec.extracted"; hash: string }
  /**
   * `by: "kane"`: the seal after Kane's evolve of a use case, whose new tests Kane authored (R40).
   * `checkpoint`: the seal after a drift a human approved interactively (I-2): the only seal that
   * starts a fresh spec-provenance window (agent turns and records before it no longer count).
   */
  | { t: "seal"; manifest: Record<string, string>; by?: "kane"; checkpoint?: true }
  | { t: "turn.start"; n: number; owed: string[] }
  | {
      t: "turn.end";
      n: number;
      commit: string;
      filesChanged: string[];
      durationMs: number;
      appUp: boolean;
      agentExit: number;
      /** The agent's own cost and turn count for this turn, as the agent reported them (eval reads these). */
      agentUsd?: number;
      agentTurns?: number;
    }
  /**
   * `confirm`: the second replay of a test that killed mutant `mutantId` (R44), on the same mutant
   * started afresh: the kill counts only when it fails the criterion again.
   */
  | { t: "run"; kind: RunKind; turn?: number; mutantId?: string; result: TestRunResult; confirm?: true }
  | {
      t: "mutant";
      id: string;
      ac: string;
      patch: string;
      model: string;
      usd: number;
      verdict: "killed" | "survived" | "survived-by-heal" | "invalid";
      note?: string;
      /** The breaker's account of the bug in a user's terms (what Kane is told if it survives). */
      slip?: Slip;
      /**
       * The id of the surviving mutant this one re-plants after Kane evolved the use case (R40): it
       * must now be killed; any other verdict leaves the criterion vacuous.
       */
      recheck?: string;
    }
  /**
   * A planted bug survived every test of use case `uc`, and Kane evolved it (`maintain evolve`, R40):
   * `because` is what Kane was told slipped through, `minted` and `retired` the test ids its new set
   * adds and replaces, `mutants` the survivors it answers. `followUp`: the bounded second evolve
   * that asked Kane to cover criteria the first left without a test.
   */
  | { t: "falsify.evolved"; uc: string; because: string; minted: string[]; retired: string[]; credits: number; mutants: string[]; followUp?: boolean }
  /**
   * Kane's evolve of `uc` added, changed or removed sealed verifier entries (`paths`) other than the
   * tests it minted and the tests of `uc` it retired. A tamper: rolled back, never sealed, and the gate
   * stays shut until a human re-seals.
   */
  | { t: "falsify.evolve.stray"; uc: string; paths: string[]; credits: number; detail: string }
  /**
   * A drift re-plan or falsify evolve that was rolled back (nothing sealed); its Kane credits still
   * count. `acs` and `reason`: the vacuous criteria it leaves so, and why in plain words.
   */
  | { t: "redesign.dropped"; useCases: string[]; detail: string; credits: number; acs?: string[]; reason?: string }
  | { t: "drift"; rows: { kind: string; ref: string; why: string }[]; applied: boolean; credits?: number }
  | { t: "regression"; ac: string; turn: number; blamedTurn?: number; blamedCommit?: string; detail?: string }
  /**
   * The spec files (and nothing else sealed) changed since the seal: drift, not a tamper. Where it was
   * seen: `duringAgentTurn` when the coding agent may have made it (right after a headless turn, or
   * while an interactive session runs): its origin is unverified. `before`/`after`: sha256 per file,
   * as sealed and as found ("absent" for a missing file).
   */
  | { t: "spec.changed"; files: string[]; duringAgentTurn: boolean; before: Record<string, string>; after: Record<string, string> }
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

/** `rejected`: a human turned the criterion down when approving the design: never owed, never run. */
export type AcStatus = "owed" | "passing" | "proved" | "vacuous" | "regressed" | "needs-spec" | "rejected";

export type AcState = {
  id: string;
  text: string;
  useCase: string;
  cites: AcNode["cites"];
  tests: string[];
  status: AcStatus;
  /** Why a vacuous or needs-spec criterion is so, in plain words, when Holdback knows more than its status says. */
  reason?: string;
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
