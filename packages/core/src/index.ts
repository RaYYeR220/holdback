export const VERSION = "0.0.0";
export { parseLine, type KaneEvent } from "./kane/ndjson.js";
export { runKane, type RunKaneOptions, type RunKaneResult } from "./kane/run.js";
export {
  ingest,
  type IngestedSource,
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
export { seal, checkSeal, sealRecordings, checkRecordings, tier1Entries, type AppSeal, type SealEntry } from "./seal.js";
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
export { runSpecStage, reseal, resealAppFiles, appSealFiles, drivePaused, type ResumeCalls } from "./loop/spec.js";
export { runDrift, watchSpec, defaultDriftKane, type DriftKane } from "./loop/drift.js";
export { buildBrief, type BriefOptions, type AcFailure, type Blame } from "./loop/brief.js";
export { bisectRegression, BisectTampered, blameOf, lastGoodTurn, probeVerdict, type BisectDeps } from "./loop/bisect.js";
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
  runFalsify,
  sweepStaleWorktrees,
  defaultFalsifyDeps,
  falsifyVerdict,
  type FalsifyDeps,
  type FalsifyKane,
  type FalsifyResult,
  type FalsifyStopReason,
} from "./loop/falsify.js";
export {
  veniceChat,
  parseReply,
  PRICES,
  Budget,
  usdOf,
  estimateUsd,
  VeniceOutputError,
  VeniceUnreachable,
  VeniceHttpError,
  VENICE_URL,
  MAX_TOKENS,
  type ChatMessage,
  type Usage,
  type VeniceChatOptions,
  type VeniceChatResult,
} from "./breaker/venice.js";
export {
  proposeMutant,
  pickFiles,
  acKeywords,
  checkPatch,
  BudgetRefused,
  BreakerError,
  BreakerUnavailable,
  PATCH_SCHEMA,
  MAX_PATCH_LINES,
  type SourceFile,
  type Mutant,
  type ProposeOptions,
} from "./breaker/mutate.js";
export { LedgerTampered, type EventBody } from "./ledger/vouched.js";
export {
  git,
  isRepoRoot,
  headSha,
  commitAll,
  ensureHead,
  excludeFromGit,
  gitPath,
  holdbackGitOptions,
  EMPTY_HOOKS_DIR,
  changedFiles,
  checkout,
  worktreeAdd,
  worktreeRemove,
  type GitResult,
  type GitOptions,
} from "./git.js";
export {
  TAMPER_MARKER,
  markTampered,
  tamperMarker,
  manifestDigest,
  gitConfigHash,
  snapshotRecordings,
  logRecordings,
  checkRecordingsAnchor,
  type RecordingsSnapshot,
  type RecordingsAnchorCheck,
} from "./tamper.js";
