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
  listNodes,
  type ListedNode,
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
export { appendEvent, readEvents, parseEvents } from "./ledger/store.js";
export { reduce } from "./ledger/reduce.js";
export { gate } from "./ledger/gate.js";
export { loadProject, type Project, type HoldbackConfig } from "./project.js";
export { seal, checkSeal, sealRecordings, checkRecordings, type AppSeal } from "./seal.js";
export { startApp, freePort, AppStartError, type StartAppOptions, type RunningApp } from "./app.js";
export {
  guardDecision,
  writeAgentSettings,
  guardHookCommand,
  posixAbs,
  type GuardInput,
  type GuardContext,
  type GuardDecision,
  type AgentSettingsOptions,
} from "./agent/guard.js";
export { runClaudeTurn, contractPath, guardMainPath, type ClaudeTurnOptions, type ClaudeTurnResult } from "./agent/claude.js";
export type { HumanIO, ApprovalItem } from "./loop/human.js";
export { CliHumanIO, ScriptedHumanIO } from "./loop/human.js";
export { runSpecStage, resealAppFiles, appSealFiles } from "./loop/spec.js";
export { buildBrief, type BriefOptions, type AcFailure } from "./loop/brief.js";
export {
  runBuildLoop,
  defaultBuildDeps,
  evidencePath,
  EVIDENCE_DIR,
  type BuildDeps,
  type BuildOptions,
  type BuildResult,
  type BuildStopReason,
} from "./loop/build.js";
export {
  git,
  isRepoRoot,
  headSha,
  commitAll,
  ensureHead,
  excludeFromGit,
  gitPath,
  changedFiles,
  checkout,
  worktreeAdd,
  worktreeRemove,
  type GitResult,
  type CommitOptions,
} from "./git.js";
