/**
 * Shared contracts between the main process, the preload bridge and the renderer.
 *
 * Everything in `src/shared` must stay free of Node and Electron imports: the
 * renderer bundles this file directly, and the preload script runs in an isolated
 * world where Node globals are unavailable.
 */

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Environment layers, lowest precedence first. `resolveEnvLayers` applies them in
 * order so the highest applicable layer wins (SYSTEM -> ... -> TASK).
 */
export const ENV_LAYERS = [
  'SYSTEM',
  'USER',
  'CRYPTORIC',
  'PROJECT',
  'TASK'
] as const

export type EnvLayer = (typeof ENV_LAYERS)[number]

/** A resolved environment snapshot. Every spawned process receives one of these. */
export type EnvRecord = Record<string, string>

export interface EnvSnapshot {
  /** Monotonic id; new snapshots are created on every refresh. */
  id: number
  /** ISO timestamp of when this snapshot was produced. */
  createdAt: string
  /** Why the snapshot was produced. */
  reason: 'boot' | 'install' | 'manual-refresh' | 'project-open' | 'task' | 'layer-change'
  /** The merged environment variables. */
  values: EnvRecord
  /** Which layers contributed, in precedence order. */
  layers: EnvLayer[]
  /** Snapshot that this one replaced, if any. */
  previousId: number | null
}

export type ToolInstallState =
  | 'present'
  | 'missing'
  | 'mismatched'
  | 'installing'
  | 'failed'
  | 'unverified'

/**
 * Why a tool call failed.
 *
 * Classification is what makes recovery possible: "command not found" and
 * "permission denied" are both tool errors, but only the first is fixed by
 * refreshing the environment. An unclassified error has to be surfaced instead
 * of guessed at.
 */
export type ToolFailureKind =
  | 'invalid-args'
  | 'permission-denied'
  | 'not-approved'
  | 'timeout'
  | 'cancelled'
  | 'unavailable'
  | 'dependency-missing'
  | 'platform-unsupported'
  | 'output-invalid'
  | 'threw'
  | 'failed'

export type ToolSourceKind =
  | 'path'
  | 'winget'
  | 'archive'
  | 'version-manager'
  | 'project'
  | 'unknown'

/** A single registered development tool. */
export interface ToolSpec {
  /** Stable unique id, e.g. `node`. */
  id: string
  /** Display name. */
  label: string
  /** Executable names to look for on PATH, in priority order. */
  executables: string[]
  /** Arguments that print the version. */
  versionArgs: string[]
  /** Regex whose first capture group extracts the version. */
  versionPattern: string
  /** Optional semver-style constraint such as `>=20`, `^18`, or `22.x`. */
  requiredRange?: string
  /** Which layer the tool belongs to, for grouping in the UI. */
  category: 'javascript' | 'python' | 'rust' | 'jvm' | 'go' | 'dotnet' | 'native' | 'vcs' | 'container'
  /** Installers available for this tool. */
  installers: ToolInstallerSpec[]
  /** Package manager runtime ids this tool usually ships with. */
  notes?: string
}

export interface ToolInstallerSpec {
  id: string
  label: string
  source: ToolSourceKind
  /** Platform support; `['*']` means all. */
  platforms: NodeJS.Platform[] | ['*']
  /** Tier required to run this installer. */
  requiredTier: PermissionTier
  /** Trust rationale shown to the user before installation. */
  trust: string
  /** Official distribution endpoint, when the source is a direct download. */
  officialUrl?: string
}

export interface ToolStatus {
  spec: ToolSpec
  state: ToolInstallState
  /** Absolute path to the resolved executable, when found. */
  path: string | null
  /** Raw version string as printed by the tool. */
  version: string | null
  /** Which env layer the resolution came from. */
  layer: EnvLayer | null
  /** How the tool was resolved. */
  source: ToolSourceKind
  /** ISO timestamp of the last probe. */
  lastVerifiedAt: string | null
  /** Populated when `state` is `mismatched`. */
  constraint: string | null
  /** Human-readable explanation of the current state. */
  detail: string
}

export type InstallPhase =
  | 'resolve-source'
  | 'download'
  | 'verify'
  | 'install'
  | 'link'
  | 'refresh-environment'
  | 'verify-runtime'
  | 'done'
  | 'failed'

export interface InstallProgress {
  installId: string
  toolId: string
  phase: InstallPhase
  /** 0..1, or null when the phase cannot report a ratio. */
  ratio: number | null
  message: string
  at: string
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export type ProjectKind =
  | 'node'
  | 'python'
  | 'rust'
  | 'jvm-maven'
  | 'jvm-gradle'
  | 'go'
  | 'dotnet'
  | 'native-cmake'
  | 'ruby'
  | 'php'
  | 'mixed'
  | 'unknown'

export interface ProjectManifest {
  /** Path relative to the project root, POSIX separators. */
  file: string
  kind: ProjectKind
  /** Tool ids this manifest implies. */
  requires: string[]
  /** Package manager implied by lockfiles. */
  packageManager: string | null
  /** Version constraint when the manifest states one. */
  constraint: string | null
}

export interface ProjectProfile {
  root: string
  name: string
  kind: ProjectKind
  manifests: ProjectManifest[]
  /** Union of required tool ids. */
  requiredTools: string[]
  /** Preferred package manager id (`npm` | `pnpm` | `yarn` | `bun` | `pip` | `uv` | ...). */
  packageManager: string | null
  /** Commands discovered from the manifest, keyed by purpose. */
  scripts: Record<string, string>
  /** Expected dev-server port when discoverable. */
  devServerPort: number | null
  isGitRepo: boolean
  detectedAt: string
}

export type WorkspaceState =
  | 'ACTIVE'
  | 'IDLE'
  | 'RUNNING'
  | 'BUILDING'
  | 'TESTING'
  | 'ERROR'
  | 'OFFLINE'

/** A runtime the open project needs but the environment cannot currently satisfy. */
export interface EnvironmentGap {
  toolId: string
  label: string
  /** `missing` when absent, `mismatched` when present but too old. */
  kind: 'missing' | 'mismatched'
  /** Manifests that imply this requirement. */
  requiredBy: string[]
  constraint: string | null
  /** Ids of trusted installers usable on this platform. */
  installerIds: string[]
  /** Permission tier the default route requires. */
  requiredTier: string
  detail: string
}

// ---------------------------------------------------------------------------
// Terminals & processes
// ---------------------------------------------------------------------------

export type TerminalStatus = 'starting' | 'ready' | 'exited' | 'error'

export interface TerminalSessionInfo {
  id: string
  /** Absolute cwd. */
  cwd: string
  shell: string
  /** Pid of the shell process, null once exited. */
  pid: number | null
  status: TerminalStatus
  /** Snapshot id the session's environment was taken from. */
  envSnapshotId: number
  /** ISO creation time. */
  createdAt: string
  /** Whether the session's env is stale relative to the current snapshot. */
  envStale: boolean
  exitCode: number | null
  label: string
}

export type ProcessStatus = 'running' | 'exited' | 'failed' | 'stopped'

export interface ProcessInfo {
  id: string
  label: string
  command: string
  cwd: string
  pid: number | null
  status: ProcessStatus
  exitCode: number | null
  startedAt: string
  endedAt: string | null
  /** Detected listening port, when the process is a server. */
  port: number | null
  /** Tail of the output buffer. */
  logTail: string
  /** Snapshot id the process environment was taken from. */
  envSnapshotId: number
  /** True when the process env predates the current snapshot. */
  envStale: boolean
}

export interface PortOccupant {
  port: number
  pid: number | null
  processName: string | null
  /** True when the occupant was started by Cryptoric itself. */
  ownedByUs: boolean
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export const PERMISSION_TIERS = ['safe', 'ask', 'elevated', 'destructive'] as const
export type PermissionTier = (typeof PERMISSION_TIERS)[number]

export type PermissionDomain =
  | 'fs.read'
  | 'fs.write'
  | 'fs.delete'
  | 'terminal.safe'
  | 'terminal.elevated'
  | 'terminal.destructive'
  | 'git.read'
  | 'git.modify'
  | 'git.destructive'
  | 'browser.read'
  | 'browser.interact'
  | 'network.read'
  | 'network.write'
  | 'env.detect'
  | 'env.install'
  | 'env.modify'

export type PermissionDecision = 'allow' | 'ask' | 'deny'

export interface PermissionRule {
  domain: PermissionDomain
  default: PermissionDecision
  /** Optional glob for narrowing, e.g. scoping `fs.write` to a `src` subtree. */
  scope?: string
}

export interface ApprovalRequest {
  id: string
  toolId: string
  tier: PermissionTier
  title: string
  /** Rendered command / action description. */
  detail: string
  risk: string
  createdAt: string
}

export interface ApprovalResolution {
  id: string
  approved: boolean
  /** Remember the decision for the rest of the session. */
  remember: boolean
}

// ---------------------------------------------------------------------------
// Tools & the agent
// ---------------------------------------------------------------------------

/**
 * Capability families. A tool belongs to exactly one, and the tool router uses
 * it to select capabilities for a task instead of invoking everything.
 */
export type ToolCategory =
  | 'files'
  | 'code'
  | 'terminal'
  | 'runtime'
  | 'process'
  | 'git'
  | 'build'
  | 'test'
  | 'browser'
  | 'security'
  | 'research'
  | 'models'
  | 'skills'
  | 'network'
  | 'containers'
  | 'database'
  | 'observability'
  /** Deploying and hosting providers (Vercel, Cloudflare, Netlify, Render). */
  | 'deploy'
  | 'payments'
  | 'productivity'

/**
 * Risk of the effect, independent of who is asking.
 *
 * `PermissionTier` answers "is this caller allowed"; `ToolRiskLevel` answers "how
 * much does this hurt if it is wrong". Both are needed: a read-only tool can
 * still be high-risk (a network fetch to an attacker-controlled host), and a
 * destructive tool can be low-risk when scoped to a temp directory.
 */
export type ToolRiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical'

export interface ToolDescriptor {
  id: string
  label: string
  description: string
  /** Tool ids this one depends on (for ordering in the UI). */
  dependsOn: string[]
  tier: PermissionTier
  /** JSON-schema-ish input description for display. */
  inputSchema: Record<string, unknown>
  /** Capability family; defaults to `files` when a tool does not declare one. */
  category?: ToolCategory
  /** Risk of the effect, independent of permission. */
  risk?: ToolRiskLevel
  /** Hard ceiling on a single invocation. */
  timeoutMs?: number
  /** Platforms the tool can run on; `['*']` means all. */
  platforms?: NodeJS.Platform[] | ['*']
  /** Structured result contract, rendered for the UI and validated at runtime. */
  outputSchema?: Record<string, unknown>
  /** Whether the tool changes the workspace or the machine. */
  mutates?: boolean
  /**
   * Argument names whose values must never be written to the audit log, the
   * transcript, or an approval prompt.
   */
  sensitiveArgs?: string[]
}

/**
 * A file a tool produced that the agent may need to inspect or reference.
 * Tracked per task so an agent can say "the screenshot is here" without
 * inventing a path.
 */
export interface ToolArtifact {
  id: string
  taskId: string | null
  toolId: string
  kind: 'screenshot' | 'log' | 'diff' | 'report' | 'build' | 'test' | 'research' | 'other'
  path: string
  bytes: number
  createdAt: string
  summary: string
}

/**
 * One audited tool execution.
 *
 * Arguments are redacted before they land here — an audit trail that leaks the
 * secrets it was written to detect is worse than no audit trail at all.
 */
export interface ToolAuditRecord {
  id: string
  taskId: string | null
  toolId: string
  category: ToolCategory
  risk: ToolRiskLevel
  /** Redacted arguments. */
  args: string
  ok: boolean
  /** Normalised failure class, or null on success. */
  error: string | null
  errorKind: ToolFailureKind | null
  exitCode: number | null
  durationMs: number
  approved: boolean
  startedAt: string
}

/**
 * Task status.
 *
 * The named work states were added because `RUNNING` covered too much. A task
 * that was implementing, a task that was verifying and a task waiting for a
 * provider to answer were all reported identically, so a hang inside any of them
 * looked the same to the user — "Running — running" with nothing changing. Each
 * pipeline stage now has its own state, and `CANCELLING` exists so a stop is
 * visible before it completes.
 */
export type TaskStatus =
  | 'QUEUED'
  | 'ANALYZING'
  | 'PLANNING'
  | 'IMPLEMENTING'
  | 'RUNNING'
  | 'VERIFYING'
  | 'TESTING'
  | 'REVIEWING'
  | 'FIXING'
  | 'WAITING_FOR_USER'
  | 'WAITING_FOR_TOOL'
  | 'CANCELLING'
  | 'COMPLETED'
  | 'FAILED'
  | 'BLOCKED'
  | 'PAUSED'
  | 'CANCELLED'

/** Statuses a task can never leave on its own. A live task must not be one. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'BLOCKED'
]

/** True when a task is still doing something. */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status)
}

export type AgentRole =
  | 'PROJECT_ANALYZER'
  | 'PLANNER'
  | 'IMPLEMENTER'
  | 'TERMINAL_AGENT'
  | 'DEBUGGER'
  | 'TESTER'
  | 'REVIEWER'
  | 'RESEARCHER'
  | 'SECURITY_REVIEWER'
  | 'ENVIRONMENT_MANAGER'
  | 'RELEASE_MANAGER'

export interface TimelineEntry {
  id: string
  taskId: string
  at: string
  role: AgentRole | 'SYSTEM'
  stage: string
  message: string
  status: 'ok' | 'error' | 'pending' | 'info'
  /** Optional structured payload, e.g. an install id. */
  ref?: string
}

/**
 * What an execution actually did.
 *
 * Recorded per task so the final sentence can be generated from observation
 * rather than from narration. The defect this exists to prevent: an agent that
 * changed nothing reported "Task complete — no files were changed." while every
 * stage displayed as finished.
 */
export interface ExecutionEvidence {
  /** READ_ONLY | IMPLEMENTATION | … as classified from the request. */
  classification: string
  filesBefore: number
  filesAfter: number
  createdFiles: string[]
  modifiedFiles: string[]
  deletedFiles: string[]
  /** Every difference, which is the only proof any work happened. */
  changedFiles: string[]
  toolCalls: number
  failedToolCalls: number
  modelCalls: number
  /** Labels of checks that actually executed, e.g. `typecheck`, `test`. */
  testsExecuted: string[]
  finalStatus: string
  reason: string
}

/**
 * The isolated checkout a task ran in.
 *
 * A task's work landing on a branch of its own is the whole point of worktree
 * isolation, so where it landed is part of the task's result and not a detail of
 * how it was executed.
 */
export interface TaskWorktree {
  /** Absolute path of the task's own checkout. */
  path: string
  /** Branch the task's work lands on. */
  branch: string
}

export interface AgentTask {
  id: string
  title: string
  prompt: string
  status: TaskStatus
  role: AgentRole
  createdAt: string
  updatedAt: string
  projectRoot: string | null
  /** Files this task owns; used for multi-agent locking. */
  ownedPaths: string[]
  /** Files this task has modified. */
  changedPaths: string[]
  error: string | null
  usage: UsageRecord
  /**
   * The isolated checkout this task ran in, when isolation was on.
   *
   * Absent otherwise, and the absence is meaningful: "this task wrote into the
   * project folder" and "this task wrote into a checkout" must not look alike to
   * a reviewer.
   */
  worktree?: TaskWorktree | null
  /** Observed effect of the run. Absent until a stage measures it. */
  evidence?: ExecutionEvidence
}

export interface UsageRecord {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  /** USD estimate; 0 when no pricing is configured. */
  estimatedCostUsd: number
}

/**
 * One entry in the persisted conversation.
 *
 * The transcript lives in the main process, on disk, so it survives a restart
 * and can be fed back to the model as context. `tool` turns are kept alongside
 * speech deliberately: they are the evidence that the agent ran something, and
 * a history that shows only claims would be worse than no history.
 */
export interface ConversationTurn {
  id: string
  at: string
  role: 'user' | 'assistant' | 'tool'
  text: string
  /** Tool id, present only on `tool` turns. */
  tool?: string
  /** Whether the tool succeeded, present only on `tool` turns. */
  ok?: boolean
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export interface SkillDescriptor {
  id: string
  name: string
  description: string
  /** Absolute path of the skill directory or file. */
  path: string
  /** `global` | `project` | `builtin`. */
  scope: 'builtin' | 'global' | 'project'
  /** Task categories the skill claims. */
  categories: string[]
  enabled: boolean
  /** Permissions the skill declares it needs. */
  permissions: PermissionDomain[]
  version: string | null
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

export interface BrowserTabInfo {
  id: string
  url: string
  title: string
  loading: boolean
}

export interface BrowserConsoleEntry {
  level: 'error' | 'warning' | 'info' | 'log'
  text: string
  source: string
  line: number | null
  at: string
}

export interface BrowserNetworkFailure {
  url: string
  error: string
  at: string
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface DiagnosticEntry {
  label: string
  ok: boolean
  value: string
  detail: string
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export interface FileChange {
  path: string
  /** Git-style status letter. */
  status: 'M' | 'A' | 'D' | 'R' | '??'
  additions: number
  deletions: number
  binary: boolean
  /** Unified diff; empty for binary or untracked-binary files. */
  patch: string
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

export interface FileNode {
  name: string
  path: string
  kind: 'file' | 'dir'
  /** Size in bytes; 0 for directories. */
  size: number
  /** Children for directories; omitted for files. */
  children?: FileNode[]
}

export interface FileContents {
  path: string
  content: string
  binary: boolean
}

export interface FileWriteResult {
  path: string
  bytes: number
}

export interface FileSearchHit {
  path: string
  name: string
  matches: number
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

export interface GitStatusEntry {
  path: string
  /** Porcelain index status letter. */
  index: string
  /** Porcelain worktree status letter. */
  worktree: string
  staged: boolean
}

export interface GitStatus {
  isRepo: boolean
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  entries: GitStatusEntry[]
  clean: boolean
}

export interface GitDiffResult {
  files: FileChange[]
  raw: string
}

export interface GitCheckpointResult {
  created: boolean
  commit: string | null
  message: string
  error: string | null
}

export interface GitWorktreeEntry {
  path: string
  head: string | null
  branch: string | null
  detached: boolean
  /** True for the repository's own working tree. */
  main: boolean
}

// ---------------------------------------------------------------------------
// Events pushed from main -> renderer
// ---------------------------------------------------------------------------

export type MainEvent =
  | { type: 'timeline'; entry: TimelineEntry }
  | { type: 'task'; task: AgentTask }
  | { type: 'install-progress'; progress: InstallProgress }
  | { type: 'env-changed'; snapshot: EnvSnapshot; tools: ToolStatus[] }
  | { type: 'terminal-output'; sessionId: string; chunk: string; stream: 'stdout' | 'stderr' }
  | { type: 'terminal-exit'; sessionId: string; exitCode: number | null }
  | { type: 'process'; process: ProcessInfo }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string; at: string }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'conversation'; turn: ConversationTurn }
  | { type: 'project'; project: ProjectProfile }
  | { type: 'browser-console'; tabId: string; entries: BrowserConsoleEntry[] }
  | { type: 'update'; state: UpdateState }
  | { type: 'browser-tabs'; tabs: BrowserTabInfo[] }

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error' | 'up-to-date'
  version: string | null
  ratio: number | null
  notes: string | null
  channel: 'stable' | 'beta' | 'nightly'
  error: string | null
}