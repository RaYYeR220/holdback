export const VERSION = "0.0.0";
export { parseLine, type KaneEvent } from "./kane/ndjson.js";
export { runKane, type RunKaneOptions, type RunKaneResult } from "./kane/run.js";
export {
  ingest,
  extractResume,
  resumeSession,
  tokenize,
  review,
  designTests,
  readGraph,
  coverGaps,
  reconcile,
  balance,
  sumCredits,
  type PendingQuestion,
  type Paused,
  type IngestResult,
  type DesignResult,
  type ReconcileResult,
  type ReconcileRow,
  type UseCaseNode,
  type AcNode,
  type TestNode,
  type GapNode,
  type Graph,
} from "./kane/assurance.js";
export {
  parseTestMd,
  runTest,
  runTests,
  type BugVerdict,
  type TestRunResult,
  type RunTestOptions,
} from "./kane/testmd.js";
export type {
  RunKind,
  LedgerEvent,
  AcStatus,
  AcState,
  LedgerState,
} from "./ledger/types.js";
export { appendEvent, readEvents } from "./ledger/store.js";
export { reduce } from "./ledger/reduce.js";
export { gate } from "./ledger/gate.js";
export { loadProject, type Project, type HoldbackConfig } from "./project.js";
export { seal, checkSeal } from "./seal.js";
export { startApp, freePort, AppStartError, type StartAppOptions, type RunningApp } from "./app.js";
export {
  guardDecision,
  writeAgentSettings,
  posixAbs,
  type GuardInput,
  type GuardContext,
  type GuardDecision,
  type AgentSettingsOptions,
} from "./agent/guard.js";
export { runClaudeTurn, contractPath, type ClaudeTurnOptions, type ClaudeTurnResult } from "./agent/claude.js";
