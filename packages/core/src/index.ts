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
export { seal, checkSeal, appSealKey, isAppKeyOf, sealRecordings, checkRecordings, tier1Entries, type AppSeal, type SealEntry } from "./seal.js";
export { startApp, freePort, AppStartError, type StartAppOptions, type RunningApp } from "./app.js";
export {
  guardDecision,
  guardPayload,
  agentDenyRules,
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
export { runDrift, watchSpec, defaultDriftKane, type DriftKane, type DriftResult } from "./loop/drift.js";
export { buildBrief, byAcId, type BriefOptions, type AcFailure, type Blame } from "./loop/brief.js";
export { bisectRegression, BisectTampered, blameOf, lastGoodTurn, probeVerdict, type BisectDeps } from "./loop/bisect.js";
export {
  runBuildLoop,
  defaultBuildDeps,
  evidencePath,
  lastSeal,
  EVIDENCE_DIR,
  VerifySession,
  type SessionStop,
  type BuildDeps,
  type BuildOptions,
  type BuildResult,
  type BuildStopReason,
} from "./loop/build.js";
export {
  checkOnce,
  readCheckState,
  writeCheckState,
  acquireCheckLock,
  markEdit,
  readEditAt,
  forAgent,
  CHECK_STATE,
  CHECK_LOCK,
  EDIT_MARK,
  type CheckDeps,
  type CheckOptions,
  type CheckReason,
  type CheckResult,
  type CheckState,
  type CheckStatus,
  type CheckLock,
  type LockOptions,
} from "./loop/check.js";
export {
  runFalsify,
  sweepStaleWorktrees,
  defaultFalsifyDeps,
  falsifyVerdict,
  type FalsifyDeps,
  type FalsifyOptions,
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
  worktreeTree,
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
