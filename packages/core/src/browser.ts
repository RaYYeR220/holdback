/**
 * `@holdback/core/browser`: the pure ledger logic, with no node APIs anywhere in its import graph.
 * The dashboard's replay mode parses and reduces a recorded ledger with exactly the code the CLI
 * and the server use (test/browser.test.ts keeps this graph free of node modules).
 */
export { parseEvents } from "./ledger/parse.js";
export { decidesStatus, reduce } from "./ledger/reduce.js";
export { gate } from "./ledger/gate.js";
export { verdict, type Verdict, type VerdictState } from "./ledger/verdict.js";
export { retiredTests, type RetiredTest } from "./ledger/retired.js";
export { eventCredits } from "./ledger/credits.js";
export { notAnAppFailure } from "./kane/outcome.js";
export type { RunKind, LedgerEvent, AcStatus, AcState, LedgerState } from "./ledger/types.js";
export type { AcNode, TestNode, GapNode, PendingQuestion } from "./kane/assurance.js";
export type { BugVerdict, TestRunResult } from "./kane/testmd.js";
export type { ApprovalItem } from "./loop/human.js";
export type { PendingPrompt } from "./server.js";
