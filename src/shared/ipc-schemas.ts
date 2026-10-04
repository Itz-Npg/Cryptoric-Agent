/**
 * IPC argument schemas.
 *
 * Main process only. Every channel declared in `ipc-channels.ts` must have an
 * entry here; the router refuses to dispatch a channel with no schema, so this
 * map doubles as the enforcement point that the two files stay in sync.
 */

import { z } from 'zod'
import { CHANNELS } from './ipc-channels'

const rootSchema = z.string().min(1)

export const SCHEMAS = {
  [CHANNELS.appInfo]: z.object({}),
  [CHANNELS.stateGet]: z.object({}),
  [CHANNELS.stateSet]: z.object({ patch: z.record(z.unknown()) }),
  [CHANNELS.settingsGet]: z.object({}),
  [CHANNELS.settingsUpdate]: z.object({ patch: z.record(z.unknown()) }),
  [CHANNELS.settingsResolve]: z.object({ projectRoot: z.string().nullable() }),
  [CHANNELS.settingsReset]: z.object({
    path: z.string().min(1).optional(),
    section: z.string().min(1).optional(),
    all: z.boolean().optional()
  }),
  [CHANNELS.settingsExport]: z.object({}),
  [CHANNELS.settingsImport]: z.object({
    payload: z.unknown(),
    mode: z.enum(['merge', 'replace']).optional()
  }),
  [CHANNELS.settingsProjectOverride]: z.object({
    projectRoot: z.string().min(1),
    override: z.record(z.unknown()).nullable()
  }),

  // An empty `root` means "prompt the user to pick a directory", so the string
  // is intentionally not length-constrained here.
  [CHANNELS.projectOpen]: z.object({ root: z.string() }),
  [CHANNELS.projectClose]: z.object({}),
  [CHANNELS.projectList]: z.object({}),
  [CHANNELS.projectGaps]: z.object({}),

  [CHANNELS.envInspect]: z.object({ includeAll: z.boolean().optional() }),
  [CHANNELS.envInstall]: z.object({
    toolId: z.string().min(1),
    version: z.string().optional(),
    installerId: z.string().optional()
  }),
  [CHANNELS.envCancelInstall]: z.object({ toolId: z.string().min(1) }),
  [CHANNELS.envRefresh]: z.object({}),
  [CHANNELS.envSnapshot]: z.object({}),

  [CHANNELS.terminalCreate]: z.object({ cwd: z.string().optional(), label: z.string().optional() }),
  [CHANNELS.terminalWrite]: z.object({ sessionId: z.string().min(1), data: z.string().max(1_000_000) }),
  [CHANNELS.terminalRefresh]: z.object({ sessionId: z.string().min(1), closeOld: z.boolean().optional() }),
  [CHANNELS.terminalClose]: z.object({ sessionId: z.string().min(1) }),
  [CHANNELS.terminalList]: z.object({}),

  [CHANNELS.processStart]: z.object({
    label: z.string().min(1).max(200),
    command: z.string().min(1).max(400),
    args: z.array(z.string().max(2000)).max(64).optional(),
    cwd: rootSchema,
    expectedPort: z.number().int().min(1).max(65535).optional()
  }),
  [CHANNELS.processList]: z.object({}),
  [CHANNELS.processStop]: z.object({ processId: z.string().min(1) }),
  [CHANNELS.processRestart]: z.object({ processId: z.string().min(1) }),
  [CHANNELS.processLogs]: z.object({ processId: z.string().min(1) }),
  [CHANNELS.portScan]: z.object({
    from: z.number().int().min(1).max(65535),
    to: z.number().int().min(1).max(65535)
  }),

  [CHANNELS.gitStatus]: z.object({}),
  [CHANNELS.gitDiff]: z.object({ path: z.string().optional() }),
  [CHANNELS.gitCheckpoint]: z.object({ message: z.string().max(200).optional() }),
  [CHANNELS.gitCommit]: z.object({ message: z.string().min(1).max(4000) }),

  [CHANNELS.fileRead]: z.object({ path: z.string().min(1) }),
  [CHANNELS.fileWrite]: z.object({ path: z.string().min(1), content: z.string().max(5_000_000) }),
  [CHANNELS.fileSearch]: z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(500).optional() }),
  [CHANNELS.fileTree]: z.object({ path: z.string().optional(), depth: z.number().int().min(1).max(8).optional() }),

  [CHANNELS.agentSubmit]: z.object({
    prompt: z.string().min(1).max(20_000),
    title: z.string().max(200).optional(),
    role: z
      .enum([
        'PROJECT_ANALYZER', 'PLANNER', 'IMPLEMENTER', 'TERMINAL_AGENT', 'DEBUGGER',
        'TESTER', 'REVIEWER', 'RESEARCHER', 'SECURITY_REVIEWER', 'ENVIRONMENT_MANAGER',
        'RELEASE_MANAGER'
      ])
      .optional()
  }),
  [CHANNELS.agentList]: z.object({}),
  [CHANNELS.agentStop]: z.object({ taskId: z.string().min(1) }),
  [CHANNELS.agentPause]: z.object({ taskId: z.string().min(1) }),
  [CHANNELS.agentResume]: z.object({ taskId: z.string().min(1) }),
  // Reading history is a read. Clearing it destroys it, so it is gated the
  // same way any other irreversible change is.
  [CHANNELS.conversationList]: z.object({}),
  [CHANNELS.conversationClear]: z.object({}),
  [CHANNELS.approvalResolve]: z.object({
    id: z.string().min(1),
    approved: z.boolean(),
    remember: z.boolean().optional(),
    // Needed to apply a session grant: the grant is per permission domain, and
    // the domain is known from the tool, not from the id alone.
    toolId: z.string().min(1).max(120).optional()
  }),
  [CHANNELS.approvalList]: z.object({}),
  [CHANNELS.toolsList]: z.object({}),

  [CHANNELS.skillList]: z.object({}),
  [CHANNELS.skillSetEnabled]: z.object({ id: z.string().min(1), enabled: z.boolean() }),
  [CHANNELS.skillRoute]: z.object({ prompt: z.string().min(1).max(20_000), paths: z.array(z.string()).max(200).optional() }),

  [CHANNELS.permissionList]: z.object({}),
  [CHANNELS.permissionSet]: z.object({
    domain: z.string().min(1),
    decision: z.enum(['allow', 'ask', 'deny']),
    scope: z.string().optional()
  }),

  [CHANNELS.modelsCatalog]: z.object({}),
  [CHANNELS.modelsSelect]: z.object({ modelId: z.string().min(1) }),
  [CHANNELS.modelsAvailable]: z.object({}),
  [CHANNELS.modelsSetBudget]: z.object({ coins: z.number().int().min(0).max(100_000) }),
  [CHANNELS.modelsSetProvider]: z.object({
    provider: z.enum(['none', 'ollama', 'openai-compatible', 'openrouter', 'apinex']),
    endpoint: z.string().max(400),
    model: z.string().max(200),
    credentialKey: z.string().max(120).nullable(),
    referer: z.string().max(400).optional()
  }),

  [CHANNELS.modelsVerifyKey]: z.object({}),
  // An API key is a secret: the schema bounds it, and the handler stores it
  // encrypted. It is never echoed back and never written to the state file.
  [CHANNELS.modelsSetKey]: z.object({ apiKey: z.string().min(8).max(400) }),

  // Checking is cheap and happens on a schedule; downloading is the user's
  // decision, which is why it is a separate call and not an argument here.
  [CHANNELS.updatesStatus]: z.object({}),
  [CHANNELS.updatesCheck]: z.object({ force: z.boolean().optional() }),
  [CHANNELS.updatesDownload]: z.object({}),
  [CHANNELS.updatesInstall]: z.object({}),

  [CHANNELS.diagnostics]: z.object({})
} as const

/**
 * Channels the renderer may invoke. The `push:*` channels are main -> renderer
 * only and are deliberately excluded: the renderer must never be able to emit on
 * them, which is what stops a compromised page forging agent activity.
 */
export type InvocableChannel = Exclude<(typeof CHANNELS)[keyof typeof CHANNELS], `push:${string}`>

/**
 * Compile-time guarantee that every invocable channel has a schema.
 * Adding an invocable channel without one is a type error, not a runtime
 * surprise.
 *
 * The tuple wrapper is load-bearing: a bare conditional over a type that
 * evaluates to `never` distributes and collapses back to `never`, which would
 * make this assertion silently vacuous.
 */
type MissingSchemas = Exclude<InvocableChannel, keyof typeof SCHEMAS>
export type AllChannelsHaveSchemas = [MissingSchemas] extends [never] ? true : never
export const ALL_CHANNELS_HAVE_SCHEMAS: AllChannelsHaveSchemas = true