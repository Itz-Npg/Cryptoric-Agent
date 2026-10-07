/**
 * Electron main process.
 *
 * Security defaults applied here (see `docs/security-review.md`):
 *   - `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
 *   - navigation and window-open are denied; only the bundled renderer is allowed
 *   - CSP is set by the renderer document, not weakened here
 *   - no remote module, no `webviewTag`
 *
 * The window is created only after the environment manager has produced its
 * first snapshot, so the UI never renders against a half-initialised registry.
 */

import { app, BrowserWindow, dialog, ipcMain, nativeImage, safeStorage, screen, shell, Menu } from 'electron'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHANNELS } from '@shared/ipc-channels'
import { EnvironmentManager } from './services/env/manager'
import { ToolDetector } from './services/env/detect'
import { TerminalSessionManager } from './services/terminal/sessions'
import { ProcessSupervisor, findFreePort, scanPorts } from './services/proc/supervisor'
import { PermissionPolicy, ApprovalQueue, DEFAULT_PERMISSION_RULES, tierForDomain } from './services/permissions/policy'
import { SkillRegistry, DEFAULT_SKILL_ROOTS, routeSkills } from './services/skills/registry'
import { ToolRegistry } from './services/tools/registry'
import { ToolRuntime } from './services/tools/runtime'
import { AuditSink } from './services/tools/audit-sink'
import { buildEnvironmentTools } from './services/tools/builtin/environment'
import { buildFilesystemTools } from './services/tools/builtin/filesystem'
import { buildCommandTools } from './services/tools/builtin/command'
import { buildGitTools } from './services/tools/builtin/git'
import { buildResearchTools } from './services/tools/builtin/research'
import { buildProjectTools } from './services/tools/builtin/project'
import { BrowserTabManager } from './services/browser/tabs'
import { buildBrowserTools } from './services/browser/tools'
import { AgentRuntime } from './services/agent/core'
import { buildPipeline } from './services/agent/stages'
import { runAgentLoop, describeExecution } from './services/agent/loop'
import { formatExecutionLog, heartbeatLine } from './services/agent/execution'
import { chanSystemPrompt, planSystemPrompt } from './services/agent/prompts'
import { ConversationStore, deriveTitle } from './services/agent/conversation'
import { MirroredConversation } from './services/agent/mirrored-conversation'
import type { StageContext } from './services/agent/pipeline-types'
import { IpcRouter } from './ipc/router'
import { createStore, CredentialStore, type AppState } from './services/store'
import { SettingsStore } from './services/settings/store'
import type { SettingsSection } from './services/settings/schema'
import { detectProject, computeGaps } from './services/project/detect'
import { fetchCatalogue, toProviderConfigs } from './services/models/catalogue'
import {
  customModelConfigs,
  normaliseCustomProvider,
  removeCustomProvider,
  upsertCustomProvider,
  urlLeaksSecret
} from './services/models/custom-providers'
import { ensureProjectWorkspace, resolveHistoryPaths } from './services/project/workspace'
import { SessionLedger, ledgerPath } from './services/session/ledger'
import { beginSession as beginSessionForTask } from './services/session/charge'
import { AgentServerClient, serverConfigFrom } from './services/server/client'
import { remainingMs, resumableGrant } from '@shared/session-time'
import type { RunMode } from '@shared/mode'
import {
  authorizeUrl,
  createAttempt,
  describeMissingClientId,
  exchangeCode,
  fetchIdentity,
  stateMatches,
  attemptIsFresh,
  type AuthAttempt
} from './services/auth/google'
import {
  AUTH_CREDENTIAL,
  parseSession,
  readStoredAccountId,
  summarise,
  type SessionSummary
} from './services/auth/session-store'
import { CALLBACK_PORT, CALLBACK_URI, startCallbackListener, type CallbackListener } from './services/auth/loopback'
import { startSignIn } from './services/auth/sign-in'
import { describeMode, modeRequiresAccount, resolveMode } from '../shared/mode'
import { FileService } from './services/fs/files'
import { GitService } from './services/git/service'
import { WorktreeManager } from './services/git/worktree'
import {
  ModelGateway,
  MODEL_CATALOG,
  OPENROUTER_CREDENTIAL,
  PROVIDER_SERVER_CREDENTIAL,
  APINEX_CREDENTIAL,
  PROVIDER_CREDENTIAL_SLOTS,
  type ModelConfig,
  type ProviderKind
} from './services/models/gateway'
import { readEnvFile } from './services/models/dotenv'
import { UpdateService } from './services/updater'
import { createElectronUpdatePort } from './services/updater-electron'
import type { ProjectProfile, ToolStatus, MainEvent } from '@shared/types'

const dirname_ = fileURLToPath(new URL('.', import.meta.url))

let mainWindow: BrowserWindow | null = null

/**
 * Policy, for the development review hooks only.
 *
 * Declared at module scope because the hooks live outside `boot()`; assigned
 * during boot. Null until then, and every use is null-guarded.
 */
let policyRef: PermissionPolicy | null = null

interface Services {
  env: EnvironmentManager
  terminals: TerminalSessionManager
  processes: ProcessSupervisor
  browser: BrowserTabManager
  tools: ToolRegistry
  policy: PermissionPolicy
  approvals: ApprovalQueue
  skills: SkillRegistry
  agent: AgentRuntime
  router: IpcRouter
  store: ReturnType<typeof createStore>
  credentials: CredentialStore
  conversation: MirroredConversation
  /** Reopen the last project and resume anything it left running. */
  reopenLastProject(): Promise<void>
  getProject(): ProjectProfile | null
}

let services: Services | null = null

/**
 * Module-scope handle so the launch-time check can reach the update service
 * without threading it through `boot()`'s return value.
 */
let updateService: UpdateService | null = null

async function bootUpdateCheck(): Promise<void> {
  if (!updateService) return
  try {
    await updateService.check()
  } catch (err) {
    // The service records its own failure; this is the belt-and-braces guard so
    // a launch-time throw can never take the app down.
    push({
      type: 'log',
      level: 'warn',
      message: `Update check failed: ${err instanceof Error ? err.message : String(err)}`,
      at: new Date().toISOString()
    })
  }
}

function push(event: MainEvent): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(CHANNELS.push, event)
}

/**
 * Schemes `shell.openExternal` is allowed to hand to the OS.
 *
 * `openExternal` is a process launcher, not a URL opener: on Windows,
 * `file://…/x.hta`, `ms-msdt:` and `search-ms:` have all been used to turn an
 * "open this link" call into code execution. Both places that reach it take a
 * URL the renderer influenced, so only the schemes that meaningfully mean
 * "open a web page or an email" are forwarded; everything else is logged and
 * dropped.
 */
const SAFE_EXTERNAL_SCHEMES = new Set(['https:', 'http:', 'mailto:'])

function openExternalSafely(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    console.warn('[security] blocked openExternal for a URL that does not parse:', url.slice(0, 200))
    return
  }
  if (!SAFE_EXTERNAL_SCHEMES.has(parsed.protocol)) {
    console.warn(`[security] blocked openExternal for scheme "${parsed.protocol}"`)
    return
  }
  void shell.openExternal(parsed.toString())
}

async function boot(): Promise<Services> {
  const userDataDir = app.getPath('userData')
  const managedRoot = join(userDataDir, 'tools', 'cryptoric-tools')
  const scratchDir = join(userDataDir, 'tmp')

  const store = createStore(userDataDir)
  const state = await store.load()

  // Settings are loaded after the legacy state so the first run after an
  // upgrade can seed the new schema from the old flat file.
  const settings = new SettingsStore({ userDataDir, legacyState: state })
  await settings.load()

  const policy = new PermissionPolicy(DEFAULT_PERMISSION_RULES)
  policyRef = policy
  for (const [domain, decision] of Object.entries(state.permissionOverrides ?? {})) {
    if (decision !== 'allow' && decision !== 'ask' && decision !== 'deny') continue
    policy.setRule(domain as Parameters<PermissionPolicy['setRule']>[0], decision)
  }

  const env = new EnvironmentManager({
    userDataDir,
    managedRoot,
    scratchDir,
    platform: process.platform,
    detector: new ToolDetector()
  })
  await env.init()

  const approvals = new ApprovalQueue()

  const authorize = async (
    tier: 'safe' | 'ask' | 'elevated' | 'destructive',
    title: string,
    detail: string
  ): Promise<boolean> => {
    const request = approvals.request({
      toolId: 'env.install',
      tier,
      title,
      detail,
      risk: `Requires ${tier} permission.`
    })
    push({ type: 'approval', request })
    return approvals.wait(request.id)
  }

  const terminals = new TerminalSessionManager(env, {
    onOutput: (sessionId, chunk, stream) => push({ type: 'terminal-output', sessionId, chunk, stream }),
    onExit: (sessionId, exitCode) => push({ type: 'terminal-exit', sessionId, exitCode }),
    onChange: () => undefined
  })

  const processes = new ProcessSupervisor(env, {
    onChange: (process) => push({ type: 'process', process }),
    onOutput: (processId, chunk, stream) => {
      const session = processes.get(processId)
      void session
      push({ type: 'terminal-output', sessionId: processId, chunk, stream })
    }
  })

  let project: ProjectProfile | null = null

  // The integrated browser. Tabs are WebContentsViews inside this window and
  // their profiles live under the app cache dir — never in the repository and
  // never as a downloaded browser.
  const browser = new BrowserTabManager({
    userDataDir,
    getWindow: () => mainWindow
  })

  const tools = new ToolRegistry()
  tools.registerAll(buildEnvironmentTools({ env, terminals, processes, authorize }))
  tools.registerAll(buildBrowserTools({ tabs: browser }))

  const skills = new SkillRegistry()
  await skills.discover(DEFAULT_SKILL_ROOTS, state.lastProjectRoot)

  // Filesystem and Git are scoped to the open project's roots; when no project is
  // open both services report "empty" rather than exposing the user's disk.
  const getRoots = (): string[] => {
    const root = project?.root
    return root ? [root] : []
  }
  const files = new FileService(getRoots)
  const git = new GitService(getRoots)

  // Registered after `files` exists: the filesystem tools resolve every path
  // through that service, so they cannot be constructed before it.
  tools.registerAll(buildFilesystemTools({ files, policy, getRoots }))
  tools.registerAll(buildCommandTools({ env, getRoots }))
  // Git was reachable from the status panel through IPC but was not a tool, so
  // an agent could rewrite a repository and never see or record what it did.
  tools.registerAll(buildGitTools({ git, getRoots }))
  // Network read, and the project-level questions an unfamiliar repository
  // raises. `buildResearchTools` takes no dependencies: it uses the platform's
  // own fetch, which is why the CLI can register it too.
  tools.registerAll(buildResearchTools())
  tools.registerAll(buildProjectTools({ env, getRoots }))

  // The transcript is owned by the main process and written to disk. Keeping it
  // here rather than in renderer state is what makes it survive a restart and
  // gives the model something to remember.
  const conversation = new MirroredConversation(
    resolveHistoryPaths(
      {
        appDir: userDataDir,
        // Replaced the moment a project is opened; until then the project copy
        // resolves to nothing and the app copy carries the session.
        projectDir: '',
        location: settings.get().sessions.historyLocation
      },
      'no-project'
    ).writes
  )
  // Restore the scope of the project that was open last session. The project
  // itself is not auto-opened, but without this its transcript would sit in the
  // file while the chat pane showed the empty "no project" scope — history that
  // exists but appears to have been lost.
  conversation.setProject(state.lastProjectRoot ?? null)

  /**
   * Persist a turn and show it.
   *
   * Every append goes through here so the on-disk transcript and what is on
   * screen can never disagree — a renderer that fabricates or reorders history
   * is exactly the failure this design exists to prevent.
   */
  const recordTurn = (turn: Parameters<ConversationStore['append']>[0]): void => {
    push({ type: 'conversation', turn: conversation.append(turn) })
  }

  // Model gateway. Reads its API key from the OS-encrypted credential store;
  // the key is never written to the plain state file.
  const activeModelId = state.modelName || 'local-default'
  const gateway = new ModelGateway({
    config: {
      provider: state.modelProvider,
      endpoint: state.modelEndpoint,
      model: activeModelId,
      credentialKey: PROVIDER_CREDENTIAL_SLOTS[state.modelProvider] ?? 'model-api-key',
      // The allowance comes from the settings store, not from
      // `state.dailyBudgetUsd * 100`. It used to, and that is why an install
      // that had been running since the allowance dropped from 500 to 25 kept
      // showing `0 / 500` forever: `migrateAllowance` rewrites
      // `usage.dailyAllowanceCoins`, and *nothing ever read that field*, so the
      // migration ran correctly and changed nothing the user could see. The
      // legacy flat value was the only thing feeding the gateway.
      dailyBudgetCoins: settings.get().usage.dailyAllowanceCoins
    },
    getApiKey: (key) => credentialsRef.get(key),
    // Read live rather than snapshotted, so a reload that records the grant is
    // visible immediately instead of the bonus appearing to be unspent forever.
    signupBonusGrantedOn: () => settings.get().usage.signupBonusGrantedOn,
    onUsage: () => undefined
  })
  // Declared after `boot` closes over `credentials`; resolved lazily.
  const credentialsRef: { get(key: string | null): string | null } = { get: () => null }

  // Updates. The port is the real `electron-updater` transport; the policy
  // (when to check, never download unasked, never fake an all-clear) lives in
  // `UpdateService` so it is testable without a packaged build or a network.
  // Published at module scope so the launch-time check can reach it.
  updateService = new UpdateService({
    port: createElectronUpdatePort(),
    notify: (status) => {
      mainWindow?.webContents.send(CHANNELS.pushUpdate, status)
      // The log pane is the durable record, so an update found in the
      // background is still visible after the toast is gone.
      if (status.state === 'available' && status.availableVersion) {
        push({
          type: 'log',
          level: 'info',
          message: `Version ${status.availableVersion} is available (running ${status.currentVersion}).`,
          at: new Date().toISOString()
        })
      }
      if (status.state === 'error' && status.error) {
        push({
          type: 'log',
          level: 'warn',
          message: `Update check failed: ${status.error}`,
          at: new Date().toISOString()
        })
      }
    }
  })
  const updates = updateService

  const bindCredentials = (c: CredentialStore): void => {
    credentialsRef.get = (key: string | null) => (key ? c.get(key) : null)
  }

  // --------------------------------------------------------------- mode
  //
  // Resolved once, here, and handed to both the billing gate and the mode
  // route. Resolving it per request would mean a build could bill one task as
  // local and the next as hosted if the environment changed underneath it.
  //
  // A half-configured build is *refused*, not downgraded. `AGENT_SERVER_URL`
  // with no `CRYPTORIC_MODE` means someone meant to connect; falling back to the
  // local ledger would show them a balance the app is not spending.
  const modeEnv = readEnvFile([app.getPath('userData'), process.cwd()])
  const modeResult = resolveMode(modeEnv)
  const runMode: RunMode = modeResult.ok ? modeResult.mode : 'local'
  const serverConfigResult = modeResult.ok ? serverConfigFrom(modeEnv, runMode) : null
  const modeProblem = !modeResult.ok
    ? modeResult.error
    : serverConfigResult && !serverConfigResult.ok
      ? serverConfigResult.error
      : ''
  const server =
    serverConfigResult && serverConfigResult.ok && serverConfigResult.config
      ? new AgentServerClient({ config: serverConfigResult.config })
      : null

  /** The account the server should bill, read fresh: signing in changes it. */
  const currentAccountId = async (): Promise<string | null> =>
    readStoredAccountId(await credentials.get(AUTH_CREDENTIAL))

  // Every tool call, persisted. The in-memory ring answers "what just
  // happened"; the file answers "what happened before the ring rolled over",
  // and it is written from the same callback so the two can never disagree
  // about which calls were recorded.
  const auditSink = new AuditSink(join(userDataDir, 'audit.jsonl'))

  const agent = new AgentRuntime(
    {
      tools,
      runtime: new ToolRuntime({
        registry: tools,
        policy,
        approvals,
        onRecord: (record) => {
          auditSink.write(record)
          push({ type: 'log', level: 'info', message: `${record.toolId} ${record.ok ? 'ok' : 'failed'} (${record.durationMs}ms)`, at: new Date().toISOString() })
        }
      }),
      skills,
      skillTokenBudget: 6000,
      maxSkillsPerTask: 4,
      getProjectRoot: () => project?.root ?? null,
      // Isolation is a setting read per task, so turning it on applies to the
      // next task rather than the next launch. Checkouts live under the app's own
      // data directory: one inside the project would show up in the developer's
      // `git status`, which is the first thing this feature promises not to do.
      worktrees: new WorktreeManager({ baseDir: join(userDataDir, 'worktrees') }),
      worktreeIsolation: () => settings.get().sessions.worktreeIsolation,
      // Who pays, and how much, is decided in one tested place: `local` derives
      // the balance from the gateway's allowance minus the ledger, `hosted`
      // asks the server and uses its answer. A resumed task is charged nothing
      // in either mode.
      beginSession: async (task, resume) =>
        beginSessionForTask(
          {
            mode: runMode,
            server,
            blockedReason: modeProblem.length > 0 ? modeProblem : null,
            accountId: currentAccountId,
            // Balance is derived, never stored as a running total.
            localBalance: () => {
              const day = new Date().toISOString().slice(0, 10)
              return Math.max(0, gateway.budget().budgetCoins - sessionLedger.chargedOn(day))
            },
            record: (grant) => sessionLedger.record(grant),
            model: () => gateway.getConfig().model,
            // Own key or a model running on the user's machine costs nothing to
            // serve, so it is the cheap tier. Anything Cryptoric pays for is not.
            tier: () =>
              gateway.usesUserKey() || gateway.getConfig().provider === 'ollama' ? 'own' : 'hosted'
          },
          { id: task.id, projectRoot: task.projectRoot ?? '', prompt: task.prompt },
          resume
        ),
      endSession: async (grantId) => {
        await sessionLedger.markConsumed(grantId)
      },
      events: {
        timeline: (entry) => push({ type: 'timeline', entry }),
        task: (task) => push({ type: 'task', task }),
        toolResult: () => undefined,
        // Stage summaries land in the conversation too, so they survive a
        // restart alongside the model's own words.
        say: (text) => recordTurn({ role: 'assistant', text })
      }
    },
    buildPipeline({
      // A real call surface. This used to be a stub returning "not wired",
      // which was a capability that existed on paper and did nothing.
      tools: {
        call: (toolId, args) =>
          tools
            .get(toolId)
            ?.execute(args as never, {
              projectRoot: project?.root ?? null,
              taskEnv: null,
              signal: new AbortController().signal,
              note: () => undefined,
              taskId: null,
              grantedTier: 'safe',
              recordArtifact: () => ({}) as never
            }) ?? Promise.resolve({ ok: false, summary: 'Unknown tool', error: `No tool registered with id "${toolId}".` }),
        // Read from the same registry the tools come from, so a stage asking
        // "can this build drive a browser?" gets an answer that tracks the real
        // tool set instead of a separately-maintained capability flag.
        hasTool: (toolId) => tools.has(toolId)
      },
      getProject: () => project,
      probeRuntime: async (toolId) => {
        const s = await env.probeTool(toolId)
        return { state: s.state, version: s.version, detail: s.detail }
      },
      // Present only when a provider really is configured. A stage that needs
      // the model and does not get it says so; nothing here pretends.
      model: gateway.isEnabled()
        ? async (ctx, phase) => runModelPhase(ctx, phase)
        : undefined
    })
  )

  /**
   * Hand a prompt to the model and let it act.
   *
   * For `plan` the model only writes; for `implement` it gets the tool registry
   * and the loop runs until it answers in prose. Both share one persisted
   * conversation, so the model remembers what it did earlier in the session.
   */
  async function runModelPhase(
    ctx: StageContext,
    phase: 'plan' | 'implement'
  ): Promise<{
    ok: boolean
    text: string
    error: string | null
    tools: string[]
    toolCalls: number
    failedToolCalls: number
    modelCalls: number
  }> {
    const history = conversation.contextMessages()

    if (phase === 'plan') {
      const result = await gateway.complete({
        messages: [
          { role: 'system', content: planSystemPrompt() },
          ...history.map((m) => ({ role: m.role, content: m.content })),
          { role: 'user', content: ctx.task.prompt }
        ],
        maxTokens: 700,
        signal: ctx.signal
      })
      if (!result.ok) {
        ctx.note(formatExecutionLog('PLAN_FAILED', result.error ?? 'unknown error'), 'error')
        return {
          ok: false,
          text: '',
          error: result.error,
          tools: [],
          toolCalls: 0,
          failedToolCalls: 0,
          modelCalls: 1
        }
      }
      const text = result.text.trim()
      return {
        ok: true,
        text: text || 'No plan produced.',
        error: null,
        tools: [],
        toolCalls: 0,
        failedToolCalls: 0,
        modelCalls: 1
      }
    }

    const outcome = await runAgentLoop(
      {
        complete: (request) => gateway.complete(request),
        listTools: () => tools.list(),
        invoke: (toolId, args) => agent.invoke(ctx.task, toolId, args, ctx.signal, 'elevated'),
        note: (message, status) => ctx.note(message, status ?? 'info'),
        record: (role, text, tool, ok) => recordTurn({ role, text, tool, ok }),
        // Surface what the loop is doing while it does it. The reported symptom
        // was a frozen screen with no indication of anything; a heartbeat that
        // says "waiting for the model, 41s" turns a mystery into an answer.
        heartbeat: (beat) => {
          ctx.note(formatExecutionLog('HEARTBEAT', heartbeatLine(beat)), 'info')
        }
      },
      {
        systemPrompt: chanSystemPrompt(ctx.task.projectRoot),
        history,
        prompt: ctx.task.prompt,
        signal: ctx.signal,
        // The bought session *is* the runtime ceiling, so one mechanism stops a
        // runaway task and the two can never disagree. Without this the loop
        // would fall back to its own 30-minute default and quietly hand out
        // time that was never charged for.
        ...(ctx.session
          ? { limits: { maxRuntimeMs: remainingMs(ctx.session, Date.now()) } }
          : {})
      }
    )

    // Structured, timestamped, greppable. A hang found in a log is a hang that
    // can be explained; a hang found in a screenshot is a hang that can only be
    // guessed at.
    for (const line of describeExecution(outcome)) {
      ctx.note(line, line.includes('FAILED') || line.includes('TIMEOUT') ? 'error' : 'info')
    }

    // Counts are read from the loop's own records, not from prose. The old stage
    // code asked the model how many tools it had used, which is exactly the
    // question a model should not be trusted to answer.
    const failedToolCalls = outcome.toolRecords.filter((r) => r.status !== 'COMPLETED').length

    return {
      ok: outcome.ok,
      text: outcome.text,
      error: outcome.error,
      tools: outcome.called,
      toolCalls: outcome.toolRecords.length,
      failedToolCalls,
      modelCalls: outcome.calls.length
    }
  }

  const router = new IpcRouter({
    getTrustedWebContents: () => mainWindow?.webContents ?? null,
    policy,
    approvals,
    // Without this the router can create an approval but never show it, and
    // every gated channel (updates:install, env:install, process:restart) waits
    // out its timeout instead of asking the user anything.
    push
  })

  const sessionLedger = new SessionLedger(ledgerPath(userDataDir))
  void sessionLedger.load()

  /**
   * Pick up a task the last exit interrupted, if its time is still running.
   *
   * Called both when a folder is opened and at launch, because "close the app
   * and carry on" only works if the app reopens the folder on its own. Restarting
   * costs nothing: the session was paid for once, and `resumableGrant` only ever
   * returns one that has not been consumed and has not run out.
   */
  function resumeInterruptedTask(projectRoot: string): void {
    const grant = resumableGrant(sessionLedger.list(), projectRoot, Date.now())
    if (!grant) return
    agent.submit({
      title: deriveTitle(grant.prompt),
      prompt: grant.prompt,
      role: 'IMPLEMENTER',
      projectRoot: grant.projectRoot,
      // Carries the session that was already paid for. Without this a resume
      // would be charged a second time for time the user already bought,
      // which is the fastest way to make resume feel like a trap.
      resume: grant
    })
    push({
      type: 'log',
      level: 'info',
      message:
        `Resumed an interrupted task · ${Math.round(remainingMs(grant, Date.now()) / 60_000)} minutes ` +
        'left on the session already paid for.',
      at: new Date().toISOString()
    })
  }

  const credentials = new CredentialStore(join(userDataDir, 'credentials.json'), {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (v) => safeStorage.encryptString(v),
    decryptString: (b) => safeStorage.decryptString(b)
  })
  bindCredentials(credentials)
  await seedProviderCredentials(credentials)

  /**
   * Adopt the hosted provider when the machine already holds its key.
   *
   * A stored OpenRouter key is the user saying "use this". Shipping a default of
   * `none` while a working key sits in the credential store is how you get an
   * assistant that silently answers nothing. Resolved through the gateway so the
   * endpoint and wire id come from the catalogue, not from a hand-typed string.
   */
  if (state.modelProvider === 'none' && credentials.get(OPENROUTER_CREDENTIAL)) {
    const adopted = gateway.resolveModel('space-bunny-alpha')
    if (adopted) {
      gateway.setConfig(adopted)
      await store.set({
        modelProvider: adopted.provider,
        modelEndpoint: adopted.endpoint,
        modelName: 'space-bunny-alpha'
      })
    }
  }

  /**
   * Open a folder: detect it, give it a workspace, scope the transcript to
   * it, and remember it as the last project.
   *
   * Hoisted out of the route table so launch can call exactly the same code.
   * Two copies of "what opening a project does" is how the app ends up
   * reopening a folder without its workspace, or with the transcript still
   * scoped to the previous one.
   */
  const setProject = async (root: string): Promise<ProjectProfile> => {
    const detected = await detectProject(root)
    project = detected

    // Opening a folder gives it a workspace: a stable project id, and a place
    // for its history that travels with the folder. The folder ignores itself
    // in git, so this never shows up as untracked noise in the user's repo.
    const workspace = ensureProjectWorkspace(detected.root, detected.name)
    if (workspace.error) {
      // Reported rather than swallowed: a project whose folder cannot be
      // created still works, but the user should know their history is going
      // somewhere they did not expect.
      push({
        type: 'log',
        level: 'warn',
        message: `Could not create .cryptoricagent in ${detected.root}: ${workspace.error}. History is kept in the app folder only.`,
        at: new Date().toISOString()
      })
    }

    conversation.retarget(
      resolveHistoryPaths(
        {
          appDir: userDataDir,
          projectDir: workspace.dir,
          location: settings.get().sessions.historyLocation
        },
        workspace.manifest.id
      ).writes
    )

    // Scope the transcript to this project *before* anything can append, so a
    // turn can never land in the previous project's history.
    conversation.setProject(detected.root)
    env.setProjectEnv(detected.root, {})
    await skills.discover(DEFAULT_SKILL_ROOTS, detected.root)
    push({ type: 'project', project: detected })
    const current = store.get()
    await store.set({
      lastProjectRoot: detected.root,
      recentProjects: [
        { root: detected.root, name: detected.name, openedAt: new Date().toISOString() },
        ...current.recentProjects.filter((p) => p.root !== detected.root)
      ].slice(0, 10)
    })
    // Opening a folder is the moment an interrupted task can be picked up, so
    // the resume lives here rather than in the route: both the open command and
    // the launch-time reopen go through this one function, and there is no
    // second path that can forget to carry on.
    resumeInterruptedTask(detected.root)
    return detected
  }

  registerRoutes(router, {
    runMode,
    server,
    modeProblem,
    currentAccountId,
    sessionLedger,
    env,
    terminals,
    processes,
    tools,
    policy,
    approvals,
    skills,
    agent,
    store,
    settings,
    files,
    git,
    gateway,
    updates,
    credentials,
    conversation,
    recordTurn,
    getProject: () => project,
    setProject,
    push
  })

  /**
   * Move a provider key from the developer's untracked `.env` into the
   * OS-encrypted credential store, once.
   *
   * The `.env` file is gitignored and stays on disk; the credential store is
   * what the gateway reads, encrypted by safeStorage. A key already in the
   * store always wins, so deleting the line from `.env` later does not silently
   * downgrade a working install — and nothing is ever written back to `.env`.
   */
  async function seedProviderCredentials(creds: CredentialStore): Promise<void> {
    const fromFile = readEnvFile([app.getAppPath(), process.cwd(), userDataDir])
    const wanted: { slot: string; env: string }[] = [
      { slot: OPENROUTER_CREDENTIAL, env: 'OPENROUTER_API_KEY' },
      { slot: APINEX_CREDENTIAL, env: 'APINEX_API_KEY' },
      { slot: 'model-api-key', env: 'OPENAI_API_KEY' }
    ]
    for (const { slot, env } of wanted) {
      const value = process.env[env] ?? fromFile[env]
      if (!value || creds.has(slot)) continue
      const saved = await creds.set(slot, value)
      if (saved) push({ type: 'log', level: 'info', message: `Stored ${env} in the encrypted credential store.`, at: new Date().toISOString() })
      else push({ type: 'log', level: 'warn', message: `OS encryption unavailable; ${env} was not stored.`, at: new Date().toISOString() })
    }
  }

  /**
   * Reopen the folder that was open last session and pick up whatever it left
   * running.
   *
   * Without this the resume path could never fire on a relaunch: the app
   * remembered the project for its transcript but never re-opened the folder, so
   * "close the app and carry on" did nothing at all.
   *
   * Failures are swallowed on purpose. A folder that has since been moved,
   * renamed or unmounted must not stop the app from starting.
   */
  async function reopenLastProject(): Promise<void> {
    const last = store.get().lastProjectRoot
    if (!last || !existsSync(last)) return
    try {
      await setProject(last)
    } catch {
      push({
        type: 'log',
        level: 'warn',
        message: `Could not reopen ${last}; it may have been moved or renamed.`,
        at: new Date().toISOString()
      })
    }
  }

  return {
    env, terminals, processes, browser, tools, policy, approvals, skills, agent, router, store, credentials,
    conversation,
    reopenLastProject,
    getProject: () => project
  }
}

interface RouteDeps {
  /** Which mode this build runs in, and the server it bills. */
  runMode: RunMode
  server: AgentServerClient | null
  /** Why charging is impossible here, when it is. */
  modeProblem: string
  currentAccountId(): Promise<string | null>
  sessionLedger: SessionLedger
  env: EnvironmentManager
  terminals: TerminalSessionManager
  processes: ProcessSupervisor
  tools: ToolRegistry
  policy: PermissionPolicy
  approvals: ApprovalQueue
  skills: SkillRegistry
  agent: AgentRuntime
  store: ReturnType<typeof createStore>
  settings: SettingsStore
  files: FileService
  git: GitService
  gateway: ModelGateway
  updates: UpdateService
  credentials: CredentialStore
  conversation: MirroredConversation
  recordTurn(turn: Parameters<MirroredConversation['append']>[0]): void
  getProject(): ProjectProfile | null
  setProject(root: string): Promise<ProjectProfile>
  push(event: MainEvent): void
}

function registerRoutes(router: IpcRouter, deps: RouteDeps): void {
  const { env, terminals, processes, tools, policy, approvals, skills, agent, store, files, git, gateway } = deps
  const { runMode, server, modeProblem, currentAccountId, sessionLedger } = deps
  const { updates } = deps
  const settings = deps.settings
  const credentials = deps.credentials
  const { conversation } = deps

  // ------------------------------------------------------------- sign-in
  //
  // The browser does the credential entry; this window never sees a password.
  // The attempt holds the two secrets that must match, and it is cleared the
  // moment it is used, so a callback cannot be replayed.

  const clientId = readEnvFile([app.getPath('userData'), process.cwd()]).GOOGLE_CLIENT_ID ?? ''
  let attempt: AuthAttempt | null = null
  let session: SessionSummary | null = null
  /**
   * The listener for the attempt in flight, if any.
   *
   * Held so signing out (or starting again) can stop it. Without this the port
   * stayed bound until the ten-minute timeout, and a second attempt in the
   * meantime failed to bind for no reason the user could see.
   */
  let activeListener: CallbackListener | null = null

  const stopListening = (): void => {
    activeListener?.cancel()
    activeListener = null
  }

  async function loadSession(): Promise<SessionSummary | null> {
    const raw = await credentials.get(AUTH_CREDENTIAL)
    if (!raw) {
      session = null
      return null
    }
    let stored: { summary?: SessionSummary; secrets?: unknown }
    try {
      stored = JSON.parse(raw) as { summary?: SessionSummary; secrets?: unknown }
    } catch {
      // Corrupt data is signed-out-with-a-reason, never an exception, and never
      // a session the UI shows as signed in.
      session = null
      return null
    }
    const parsed = parseSession(stored.secrets)
    if (!parsed.ok || !stored.summary) {
      session = null
      return null
    }
    session = stored.summary
    return session
  }

  router.register(CHANNELS.authStatus, {
    domain: 'env.detect',
    requiresApproval: false,
    handler: async () => {
      const current = (await loadSession()) ?? session
      return {
        signedIn: current !== null && current.accountId.length > 0,
        configured: clientId.length > 0,
        account: current,
        message: current?.accountId ? null : describeMissingClientId()
      }
    }
  })

  router.register(CHANNELS.authStart, {
    domain: 'env.modify',
    requiresApproval: false,
    // The sequence — bind, open, wait — lives in `startSignIn` because order is
    // invisible to review. Opening the browser before the port is bound loses the
    // authorization code with nothing to show for it.
    handler: async () => {
      if (clientId.length === 0) return { ok: false, error: describeMissingClientId() }
      return startSignIn({
        redirectUri: CALLBACK_URI,
        buildUrl: () => {
          const next = createAttempt()
          attempt = next
          return authorizeUrl({ clientId, redirectUri: CALLBACK_URI, attempt: next })
        },
        listen: () => {
          // A second attempt replaces the first rather than competing with it
          // for the same port.
          stopListening()
          activeListener = startCallbackListener({ port: CALLBACK_PORT })
          return activeListener
        },
        openBrowser: async (url) => {
          openExternalSafely(url)
        },
        complete: (code, state) => completeSignIn(code, state),
        clearAttempt: () => {
          attempt = null
          // The listener for this attempt has settled or been cancelled, so
          // there is nothing left to hold on to.
          activeListener = null
        }
      })
    }
  })

  router.register(CHANNELS.authComplete, {
    domain: 'env.modify',
    requiresApproval: false,
    handler: async (args: { code: string; state: string }) => {
      // Kept for the case where a person pastes a redirect URL themselves —
      // which some corporate browsers make necessary.
      return completeSignIn(args.code, args.state)
    }
  })

  /**
   * The half of sign-in that is shared by both entry points.
   *
   * Order matters and is the whole security story: the attempt is consumed
   * before anything else, so a replayed callback finds nothing; `state` is
   * compared in constant time; a stale attempt is refused; only then is the code
   * redeemed, with the verifier that made it meaningful.
   */
  async function completeSignIn(code: string, state: string) {
    const current = attempt
    attempt = null
    if (!current) return { ok: false, error: 'There is no sign-in in progress.' }
    if (!stateMatches(current, state)) {
      // A state we did not issue means the callback came from somewhere else.
      return { ok: false, error: 'That sign-in response did not come from this app.' }
    }
    if (!attemptIsFresh(current, Date.now())) {
      return { ok: false, error: 'That sign-in took too long. Start again.' }
    }
    const redirectUri = CALLBACK_URI
    const token = await exchangeCode({ code, verifier: current.verifier, clientId, redirectUri })
    if (!token.ok) return { ok: false, error: token.error }
    const profile = await fetchIdentity(token.accessToken)
    if (!profile.ok) return { ok: false, error: profile.error }
    const built = summarise(profile.identity)
    if (!built.ok) return { ok: false, error: built.error }
    session = built.summary
    // The store holds strings, so the whole session is one JSON document. It
    // is not a *settings* file: it lives in the OS-encrypted credential store,
    // which is why a refresh token may be written there at all.
    const stored = await credentials.set(
      AUTH_CREDENTIAL,
      JSON.stringify({
        summary: built.summary,
        secrets: {
          refreshToken: token.refreshToken,
          accessToken: token.accessToken,
          expiresAt: token.expiresInSeconds ? Date.now() + token.expiresInSeconds * 1000 : null
        }
      })
    )
    // Refusing beats storing plaintext: the alternative is a refresh token in
    // a world-readable file, which is a standing credential.
    if (!stored) return { ok: false, error: 'OS encryption is unavailable, so the session was not saved.' }
    return { ok: true, account: built.summary }
  }

  router.register(CHANNELS.authSignOut, {
    domain: 'env.modify',
    requiresApproval: false,
    handler: async () => {
      attempt = null
      stopListening()
      session = null
      await credentials.delete(AUTH_CREDENTIAL)
      return { ok: true }
    }
  })

  // ------------------------------------------------------------- mode
  //
  // The renderer cannot read `CRYPTORIC_MODE` itself, and guessing `local`
  // would be a lie with a UI attached to it: a hosted build would show a local
  // balance and ask nobody to sign in.
  router.register(CHANNELS.balanceGet, {
    domain: 'network.read',
    requiresApproval: false,
    // In `hosted` this is the server's number, fetched on request. Showing the
    // local ledger in a hosted build would be a balance the app does not spend.
    handler: async () => {
      const day = new Date().toISOString().slice(0, 10)
      if (runMode === 'hosted') {
        if (!server) return { source: 'server' as const, ok: false, error: modeProblem || 'No account server is configured.' }
        const accountId = await currentAccountId()
        if (!accountId) {
          return { source: 'server' as const, ok: false, error: 'Sign in to see the balance this build spends.' }
        }
        const remote = await server.balance(accountId)
        if (!remote.ok) return { source: 'server' as const, ok: false, error: remote.error }
        return {
          source: 'server' as const,
          ok: true,
          accountId: remote.value.accountId,
          balance: remote.value.balance,
          dailyCoins: remote.value.dailyCoins
        }
      }
      return {
        source: 'local' as const,
        ok: true,
        balance: Math.max(0, gateway.budget().budgetCoins - sessionLedger.chargedOn(day)),
        dailyCoins: gateway.budget().budgetCoins
      }
    }
  })

  router.register(CHANNELS.modeGet, {
    domain: 'env.detect',
    requiresApproval: false,
    handler: () => {
      const resolved = resolveMode(readEnvFile([app.getPath('userData'), process.cwd()]))
      if (!resolved.ok) return { ok: false, error: resolved.error }
      return {
        ok: true,
        mode: resolved.mode,
        serverUrl: resolved.serverUrl,
        note: resolved.note,
        description: describeMode(resolved.mode),
        requiresAccount: modeRequiresAccount(resolved.mode)
      }
    }
  })

  // ------------------------------------------------------------- bootstrap
  router.register(CHANNELS.appInfo, {
    handler: () => ({
      version: app.getVersion(),
      name: app.getName(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      pid: process.pid,
      userData: app.getPath('userData')
    })
  })

  router.register(CHANNELS.stateGet, { handler: () => store.get() })
  router.register(CHANNELS.stateSet, {
    handler: (args: { patch: Record<string, unknown> }) => store.set(args.patch as Partial<AppState>)
  })

  // ------------------------------------------------------------- settings
  router.register(CHANNELS.settingsGet, { handler: () => settings.get() })
  router.register(CHANNELS.settingsResolve, {
    handler: (args: { projectRoot: string | null }) => settings.resolve(args.projectRoot)
  })
  router.register(CHANNELS.settingsUpdate, {
    domain: 'env.modify',
    requiresApproval: false,
    handler: (args: { patch: Record<string, unknown> }) => settings.update(args.patch)
  })
  router.register(CHANNELS.settingsReset, {
    domain: 'env.modify',
    requiresApproval: false,
    handler: async (args: { path?: string; section?: string; all?: boolean }) => {
      if (args.all) return settings.resetAll()
      if (args.path) return settings.resetPath(args.path)
      if (args.section) return settings.resetSection(args.section as SettingsSection)
      return settings.get()
    }
  })
  router.register(CHANNELS.settingsExport, { handler: () => settings.export() })
  router.register(CHANNELS.settingsImport, {
    domain: 'env.modify',
    requiresApproval: false,
    handler: (args: { payload: unknown; mode?: 'merge' | 'replace' }) =>
      settings.import(args.payload, args.mode ?? 'merge')
  })
  router.register(CHANNELS.settingsProjectOverride, {
    domain: 'env.modify',
    requiresApproval: false,
    handler: (args: { projectRoot: string; override: Record<string, unknown> | null }) =>
      settings.setProjectOverride(args.projectRoot, args.override as never)
  })

  // -------------------------------------------------------------- projects
  router.register(CHANNELS.projectOpen, {
    domain: 'fs.read',
    requiresApproval: false,
    handler: async (args: { root: string }) => {
      const selected = args.root || (await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] })).filePaths[0]
      if (!selected) throw new Error('No directory selected')
      const opened = await deps.setProject(selected)
      // Reopen the task that was interrupted by the last exit, if its time is
      // still running. Restarting it charges nothing: the original session was
      // already paid for, and `resumableGrant` only ever returns one that has
      // not been consumed and has not run out.
      return opened
    }
  })
  router.register(CHANNELS.projectClose, {
    domain: 'fs.read',
    requiresApproval: false,
    handler: () => {
      // Closing returns to the unscoped conversation. Without this the transcript
      // would keep showing the project that is no longer open.
      conversation.setProject(null)
      return null
    }
  })
  router.register(CHANNELS.projectList, { handler: () => store.get().recentProjects })
  router.register(CHANNELS.projectGaps, {
    handler: async () => {
      const project = deps.getProject()
      if (!project) return []
      const statuses: ToolStatus[] = await env.probeTools([...new Set([...project.requiredTools, 'git'])])
      return computeGaps(project, statuses)
    }
  })

  // ----------------------------------------------------------- environment
  router.register(CHANNELS.envInspect, {
    domain: 'env.detect',
    requiresApproval: false,
    handler: async (args: { includeAll?: boolean }) => {
      const statuses = args.includeAll ? await env.probeAllTools() : await env.probeCoreTools()
      return { snapshot: env.getSnapshot(), tools: statuses }
    }
  })
  router.register(CHANNELS.envInstall, {
    domain: 'env.install',
    handler: async (args: { toolId: string; version?: string; installerId?: string }) => {
      const outcome = await env.install(args.toolId, {
        version: args.version,
        installerId: args.installerId,
        authorize: async (tier, title, detail) => {
          const request = approvals.request({ toolId: args.toolId, tier, title, detail, risk: `Requires ${tier}.` })
          deps.push({ type: 'approval', request })
          return approvals.wait(request.id)
        },
        onProgress: (progress) => deps.push({ type: 'install-progress', progress: { ...progress, at: new Date().toISOString() } })
      })
      const statuses = await env.probeTools([args.toolId])
      deps.push({ type: 'env-changed', snapshot: env.getSnapshot(), tools: statuses })
      return outcome
    }
  })
  router.register(CHANNELS.envCancelInstall, {
    domain: 'env.install',
    requiresApproval: false,
    handler: (args: { toolId: string }) => env.cancelInstall(args.toolId)
  })
  router.register(CHANNELS.envRefresh, {
    domain: 'env.detect',
    requiresApproval: false,
    handler: async () => {
      const snapshot = await env.refresh('manual-refresh')
      terminals.markStale(snapshot.id)
      processes.markStale(snapshot.id)
      const tools = await env.probeCoreTools()
      deps.push({ type: 'env-changed', snapshot, tools })
      return { snapshot, tools }
    }
  })
  router.register(CHANNELS.envSnapshot, { handler: () => env.getSnapshot() })

  // ------------------------------------------------------------------ git
  router.register(CHANNELS.gitStatus, {
    domain: 'git.read',
    requiresApproval: false,
    handler: () => git.status()
  })
  router.register(CHANNELS.gitDiff, {
    domain: 'git.read',
    requiresApproval: false,
    handler: (args: { path?: string }) => git.diff(args.path)
  })
  router.register(CHANNELS.gitCheckpoint, {
    domain: 'git.modify',
    handler: (args: { message?: string }) => git.checkpoint(args.message)
  })
  router.register(CHANNELS.gitCommit, {
    domain: 'git.modify',
    handler: (args: { message: string }) => git.commit(args.message)
  })

  // ---------------------------------------------------------------- files
  router.register(CHANNELS.fileRead, {
    domain: 'fs.read',
    requiresApproval: false,
    handler: (args: { path: string }) => files.read(args.path)
  })
  router.register(CHANNELS.fileWrite, {
    domain: 'fs.write',
    handler: (args: { path: string; content: string }) => files.write(args.path, args.content)
  })
  router.register(CHANNELS.fileSearch, {
    domain: 'fs.read',
    requiresApproval: false,
    handler: (args: { query: string; limit?: number }) => files.search(args.query, args.limit)
  })
  router.register(CHANNELS.fileTree, {
    domain: 'fs.read',
    requiresApproval: false,
    handler: (args: { path?: string; depth?: number }) => files.tree(args.path, args.depth ?? 2)
  })

  // ------------------------------------------------------------- terminals
  router.register(CHANNELS.terminalCreate, {
    domain: 'terminal.safe',
    requiresApproval: false,
    handler: (args: { cwd?: string; label?: string }) =>
      terminals.create({ cwd: args.cwd ?? deps.getProject()?.root ?? app.getPath('home'), label: args.label })
  })
  router.register(CHANNELS.terminalWrite, {
    domain: 'terminal.safe',
    requiresApproval: false,
    handler: (args: { sessionId: string; data: string }) => terminals.write(args.sessionId, args.data)
  })
  router.register(CHANNELS.terminalRefresh, {
    domain: 'terminal.safe',
    requiresApproval: false,
    handler: (args: { sessionId: string; closeOld?: boolean }) =>
      terminals.refresh(args.sessionId, { closeOld: args.closeOld })
  })
  router.register(CHANNELS.terminalClose, {
    domain: 'terminal.safe',
    requiresApproval: false,
    handler: (args: { sessionId: string }) => terminals.close(args.sessionId)
  })
  router.register(CHANNELS.terminalList, { handler: () => terminals.list() })

  // ------------------------------------------------------------- processes
  router.register(CHANNELS.processStart, {
    domain: 'terminal.elevated',
    handler: (args: { label: string; command: string; args?: string[]; cwd: string; expectedPort?: number }) => {
      const verdict = policy.evaluateCommand(args.command, args.args ?? [], { workspaceRoots: [args.cwd] })
      if (verdict.decision === 'deny') throw new Error(`Denied: ${verdict.reason}`)
      return processes.start(args)
    }
  })
  router.register(CHANNELS.processList, { handler: () => processes.list() })
  router.register(CHANNELS.processStop, {
    domain: 'terminal.elevated',
    handler: (args: { processId: string }) => processes.stop(args.processId)
  })
  router.register(CHANNELS.processRestart, {
    domain: 'terminal.elevated',
    handler: (args: { processId: string }) => processes.restart(args.processId)
  })
  router.register(CHANNELS.processLogs, { handler: (args: { processId: string }) => processes.logs(args.processId) })
  router.register(CHANNELS.portScan, {
    domain: 'env.detect',
    requiresApproval: false,
    handler: async (args: { from: number; to: number }) => {
      const found = await scanPorts(args.from, args.to)
      return { occupied: found, freeCandidate: await findFreePort(args.from, args.to) }
    }
  })

  // ------------------------------------------------------------------ agent
  router.register(CHANNELS.agentSubmit, {
    domain: 'terminal.safe',
    requiresApproval: false,
    handler: (args: { prompt: string; title?: string; role?: Parameters<typeof agent.submit>[0]['role'] }) => {
      const prompt = typeof args.prompt === 'string' ? args.prompt : ''
      if (prompt.trim().length === 0) throw new Error('The prompt was empty.')
      // The user's own words are part of the transcript, not just the agent's
      // reply. Recording them here means the history reads as a conversation
      // and the model has the request in context on the next turn.
      deps.recordTurn({ role: 'user', text: prompt })
      return agent.submit({
        // A pasted prompt can start with a rule of `=` or a fragment of HTML.
        // `prompt.slice(0, 60)` put that in the task list verbatim.
        title: args.title?.trim() || deriveTitle(prompt),
        prompt,
        role: args.role ?? 'PROJECT_ANALYZER'
      })
    }
  })
  router.register(CHANNELS.agentList, { handler: () => agent.listTasks() })
  router.register(CHANNELS.agentStop, { handler: (args: { taskId: string }) => agent.stop(args.taskId) })
  router.register(CHANNELS.agentPause, { handler: (args: { taskId: string }) => agent.pause(args.taskId) })
  router.register(CHANNELS.agentResume, { handler: (args: { taskId: string }) => agent.resume(args.taskId) })
  router.register(CHANNELS.conversationList, {
    handler: () => ({ id: conversation.conversationId, turns: conversation.all() })
  })
  router.register(CHANNELS.conversationClear, {
    domain: 'env.modify',
    requiresApproval: false,
    handler: () => ({ id: conversation.conversationId, turns: conversation.clear() })
  })
  router.register(CHANNELS.toolsList, { handler: () => tools.list() })

  // ------------------------------------------------------------- approvals
  router.register(CHANNELS.approvalList, { handler: () => approvals.list() })
  router.register(CHANNELS.approvalResolve, {
    domain: 'terminal.safe',
    requiresApproval: false,
    handler: (args: { id: string; approved: boolean; remember?: boolean; toolId?: string }) => {
      // `remember` used to be accepted and thrown away, which left no way to
      // stop being asked: an agent that writes eight files for "make me a
      // website" prompted eight times with no option but Approve once or Deny.
      // The grant is scoped to the tool's own permission domain, capped at the
      // tier shown in the dialog the user actually approved (so approving an
      // `ask` prompt does not silently cover an elevated tool in the same
      // domain), expires after a bounded session window, and is never written
      // to the persisted rule set.
      if (args.approved && args.remember && args.toolId) {
        const definition = tools.get(args.toolId)
        const request = approvals.list().find((r) => r.id === args.id)
        if (definition) {
          policy.grantSession(definition.domain, 'allow', {
            ...(request ? { maxTier: request.tier } : {})
          })
          deps.push({
            type: 'log',
            level: 'info',
            message: `${args.toolId} is allowed for the rest of this session.`,
            at: new Date().toISOString()
          })
        }
      }
      return approvals.resolve(args.id, args.approved)
    }
  })

  // ---------------------------------------------------------------- skills
  router.register(CHANNELS.skillList, { handler: () => skills.list() })
  router.register(CHANNELS.skillSetEnabled, {
    domain: 'env.modify',
    requiresApproval: false,
    handler: (args: { id: string; enabled: boolean }) => skills.setEnabled(args.id, args.enabled)
  })
  router.register(CHANNELS.skillRoute, {
    domain: 'env.detect',
    requiresApproval: false,
    handler: (args: { prompt: string; paths?: string[] }) =>
      routeSkills(skills, { prompt: args.prompt, paths: args.paths ?? [], categories: [] }, {
        tokenBudget: 6000,
        maxSkills: 4
      })
  })

  // ----------------------------------------------------------- permissions
  router.register(CHANNELS.permissionList, { handler: () => policy.listRules() })
  router.register(CHANNELS.permissionSet, {
    domain: 'env.modify',
    requiresApproval: false,
    handler: (args: { domain: string; decision: 'allow' | 'ask' | 'deny'; scope?: string }) => {
      policy.setRule(args.domain as Parameters<PermissionPolicy['setRule']>[0], args.decision, args.scope)
      void store.set({ permissionOverrides: { ...store.get().permissionOverrides, [args.domain]: args.decision } })
      return policy.listRules()
    }
  })

  // -------------------------------------------------------------- models
  const modelSnapshot = () => {
    const config = gateway.getConfig()
    const budget = gateway.budget()
    return {
      models: MODEL_CATALOG.map((m) => ({
        id: m.id,
        label: m.label,
        provider: m.provider,
        kind: m.kind,
        inputPerMillion: m.inputPerMillion,
        outputPerMillion: m.outputPerMillion,
        active: gateway.isActive(m, config.model)
      })),
      budget: {
        usedCoins: budget.usedCoins,
        budgetCoins: budget.budgetCoins,
        day: budget.day,
        exceeded: budget.exceeded,
        enabled: gateway.isEnabled(),
        model: config.model,
        metered: budget.metered,
        spendUsd: budget.spendUsd,
        hasKey: gateway.usesUserKey(),
        provider: config.provider,
        endpoint: config.endpoint
      }
    }
  }

  /**
   * Pull the model catalogue from the configured provider server.
   *
   * Additive by design: a server that is switched off, unreachable or serving
   * something unusable leaves the built-in providers exactly as they were. The
   * failure is reported to the log rather than swallowed, because "my models
   * did not appear" is otherwise indistinguishable from "I misconfigured it".
   */
  /**
   * Models published by the user's provider server, kept separately from the
   * ones they added by hand.
   *
   * Both sources are re-applied together by `reseedCustomModels`. Keeping them
   * apart is what makes "remove one of my providers" not silently delete the
   * server's models as well.
   */
  let providerServerConfigs: ModelConfig[] = []

  function reseedCustomModels(): void {
    gateway.setCustomModels([
      ...providerServerConfigs,
      ...customModelConfigs(settings.get().providers)
    ])
  }

  async function refreshProviderServerCatalogue(): Promise<{ ok: boolean; models: string[]; error: string | null }> {
    const advanced = settings.get().advanced
    if (!advanced.providerServerEnabled || advanced.providerServerUrl.trim().length === 0) {
      providerServerConfigs = []
      reseedCustomModels()
      return { ok: true, models: [], error: null }
    }

    const result = await fetchCatalogue(advanced.providerServerUrl, {
      // The token lives in the credential store, never in the settings file —
      // settings are the thing most likely to be synced or copied around.
      token: credentials.get(PROVIDER_SERVER_CREDENTIAL),
      allowInsecure: advanced.providerServerAllowInsecure
    })

    if (!result.ok) {
      // The server's models go away, but the user's own providers stay: one
      // unreachable server must not empty the whole picker.
      providerServerConfigs = []
      reseedCustomModels()
      return { ok: false, models: gateway.listCustomModels(), error: result.error }
    }

    providerServerConfigs = toProviderConfigs(result.catalogue, result.url)
    reseedCustomModels()
    return { ok: true, models: gateway.listCustomModels(), error: null }
  }

  router.register(CHANNELS.modelsCatalog, {
    domain: 'env.detect',
    requiresApproval: false,
    handler: () => modelSnapshot()
  })
  router.register(CHANNELS.modelsSelect, {
    domain: 'env.modify',
    requiresApproval: false,
    handler: (args: { modelId: string }) => {
      // A catalogue entry that names a provider carries its own endpoint and
      // wire id. Selecting it must actually select that model — a row in the
      // picker that does not change the request is worse than no row.
      const resolved = gateway.resolveModel(args.modelId)
      const config: ModelConfig = resolved ?? { ...gateway.getConfig(), model: args.modelId }
      gateway.setConfig(config)
      void store.set({ modelName: args.modelId, modelProvider: config.provider, modelEndpoint: config.endpoint })
      return modelSnapshot()
    }
  })
  router.register(CHANNELS.providerServerRefresh, {
    // A network read that changes local model state. Not gated on approval:
    // the user already opted in by enabling the server in settings, and asking
    // every refresh would train people to click through the prompt.
    domain: 'network.read',
    requiresApproval: false,
    handler: async () => {
      const outcome = await refreshProviderServerCatalogue()
      push({
        type: 'log',
        level: outcome.ok ? 'info' : 'warn',
        message: outcome.ok
          ? `Provider server: ${outcome.models.length} model(s) available.`
          : `Provider server: ${outcome.error}`,
        at: new Date().toISOString()
      })
      return { ...outcome, snapshot: modelSnapshot() }
    }
  })
  router.register(CHANNELS.modelsAvailable, {
    domain: 'network.read',
    requiresApproval: false,
    handler: () => gateway.listAvailable()
  })
  router.register(CHANNELS.modelsSetBudget, {
    domain: 'env.modify',
    requiresApproval: false,
    handler: async (args: { coins: number }) => {
      gateway.setConfig({ ...gateway.getConfig(), dailyBudgetCoins: args.coins })
      // Written to the settings store, which is where the value is now read
      // from. It used to be written back to the legacy flat `dailyBudgetUsd`,
      // which is how one number ended up living in two places and the migrated
      // copy silently rotted.
      const applied = await settings.update({ 'usage.dailyAllowanceCoins': args.coins })
      if (!applied.ok) {
        return { ...modelSnapshot(), error: `Budget not saved: ${applied.issues[0]?.message ?? 'invalid'}` }
      }
      return modelSnapshot()
    }
  })
  router.register(CHANNELS.modelsSetProvider, {
    domain: 'env.modify',
    requiresApproval: false,
    handler: (args: {
      provider: ProviderKind
      endpoint: string
      model: string
      credentialKey: string | null
      referer?: string
    }) => {
      gateway.setConfig({
        ...gateway.getConfig(),
        provider: args.provider,
        endpoint: args.endpoint,
        model: args.model,
        // Default to the provider's own slot. Sending a previous provider's key
        // to a new endpoint would leak it, so the slot moves with the provider.
        credentialKey: args.credentialKey ?? PROVIDER_CREDENTIAL_SLOTS[args.provider] ?? null,
        referer: args.referer
      })
      void store.set({
        modelProvider: args.provider,
        modelEndpoint: args.endpoint,
        modelName: args.model
      })
      return modelSnapshot()
    }
  })

  // Real verification, not "the field is filled in". Asks the provider.
  router.register(CHANNELS.modelsVerifyKey, {
    domain: 'network.read',
    requiresApproval: false,
    handler: () => gateway.describeKey()
  })

  router.register(CHANNELS.modelsSetKey, {
    domain: 'env.modify',
    requiresApproval: false,
    handler: async (args: { apiKey: string }) => {
      const key = typeof args.apiKey === 'string' ? args.apiKey.trim() : ''
      if (!key) return { ok: false, configured: gateway.usesUserKey(), label: null, usage: null, limit: null, limitRemaining: null, isFreeTier: null, error: 'No key was provided.' }
      const slot = gateway.getConfig().credentialKey ?? OPENROUTER_CREDENTIAL
      const stored = await credentials.set(slot, key)
      if (!stored) {
        return { ok: false, configured: gateway.usesUserKey(), label: null, usage: null, limit: null, limitRemaining: null, isFreeTier: null, error: 'OS encryption is unavailable, so the key was not stored.' }
      }
      return gateway.describeKey()
    }
  })

  // --- custom providers
  //
  // "Add my own API" is three separate things: a base URL, a key, and the model
  // ids. The key is written straight to the credential store and never appears
  // in settings, in the response, or back in the renderer.

  router.register(CHANNELS.modelsCustomSave, {
    domain: 'env.modify',
    requiresApproval: false,
    handler: async (args: {
      id?: string
      label: string
      baseUrl: string
      apiKey?: string
      models: string[]
      /** User-declared budgets in tokens. Blank or absent means undeclared. */
      contextWindow?: number | null
      maxOutputTokens?: number | null
    }) => {
      const normalised = normaliseCustomProvider(args)
      if (!normalised.ok) {
        return { ok: false, error: normalised.error, id: null }
      }

      if (urlLeaksSecret(normalised.provider.baseUrl)) {
        // A key pasted into a URL ends up in logs, in the settings file, and in
        // any crash report. Saying so is more useful than storing it.
        return {
          ok: false,
          error: 'That URL appears to contain a key. Put the key in the key field, not in the URL.',
          id: null
        }
      }

      const { provider, apiKey } = normalised
      if (apiKey !== null && provider.credentialKey) {
        const stored = await credentials.set(provider.credentialKey, apiKey)
        if (!stored) {
          // Refusing beats storing plaintext: the alternative is a key sitting in
          // a world-readable file because the OS keychain was unavailable.
          return {
            ok: false,
            error: 'OS encryption is unavailable, so the key was not stored.',
            id: null
          }
        }
      }

      const next = upsertCustomProvider(settings.get().providers, provider)
      const result = await settings.update({ providers: next })
      if (!result.ok) {
        const detail = result.issues.map((i) => i.message).join('; ')
        return { ok: false, error: detail || 'Could not save the provider.', id: null }
      }

      // Make the new models selectable straight away rather than waiting for a
      // restart: the user just told us what they have.
      reseedCustomModels()
      push({ type: 'log', level: 'info', message: `Provider "${provider.label}" saved (${provider.models.length} model(s)).`, at: new Date().toISOString() })

      return { ok: true, error: null, id: provider.id }
    }
  })

  router.register(CHANNELS.modelsCustomRemove, {
    domain: 'env.modify',
    requiresApproval: false,
    handler: async (args: { id: string }) => {
      const current = settings.get().providers
      const { providers, removed } = removeCustomProvider(current, args.id)
      if (!removed) return { ok: false, error: 'That provider is not in the list.' }

      const result = await settings.update({ providers })
      if (!result.ok) {
        const detail = result.issues.map((i) => i.message).join('; ')
        return { ok: false, error: detail || 'Could not remove the provider.' }
      }

      // Re-seed from what is left rather than subtracting, so a partially
      // applied edit cannot leave a model pointing at a removed provider.
      reseedCustomModels()
      return { ok: true, error: null }
    }
  })

  // ----------------------------------------------------------- diagnostics
  // --- updates

  // Checking is a read of a public release feed; downloading is a network
  // write the user asked for. Both go through the router so they are audited
  // like every other action rather than slipping past the policy layer.
  router.register(CHANNELS.updatesStatus, {
    domain: 'env.detect',
    requiresApproval: false,
    handler: () => updates.getStatus()
  })
  router.register(CHANNELS.updatesCheck, {
    domain: 'network.read',
    requiresApproval: false,
    handler: (args: { force?: boolean }) => updates.check({ force: Boolean(args?.force) })
  })
  router.register(CHANNELS.updatesDownload, {
    domain: 'network.read',
    requiresApproval: false,
    handler: () => updates.download()
  })
  router.register(CHANNELS.updatesInstall, {
    domain: 'env.modify',
    // Swapping the running application is not something a page should be able
    // to cause by accident, so it is the one update action that asks first.
    requiresApproval: true,
    handler: () => updates.install()
  })

  router.register(CHANNELS.diagnostics, {
    domain: 'env.detect',
    requiresApproval: false,
    handler: async () => {
      const statuses = await env.probeAllTools()
      return {
        app: { version: app.getVersion(), electron: process.versions.electron, node: process.versions.node, pid: process.pid },
        snapshot: env.getSnapshot(),
        tools: statuses.map((s) => ({
          label: s.spec.label,
          ok: s.state === 'present',
          value: s.version ?? s.state,
          detail: s.detail
        })),
        security: {
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          permissionTierForInstall: tierForDomain('env.install')
        },
        models: modelSnapshot()
      }
    }
  })
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/**
 * Resolve the packaged application icon.
 *
 * The icon lives in `build/` relative to the source root in development and is
 * bundled into the asar in production; both layouts are checked so the window
 * never renders with Electron's default icon.
 */
function appIconPath(): string {
  const candidates = [
    join(dirname_, '../build/cryptoric-icon.png'),
    join(process.resourcesPath ?? '', 'build', 'cryptoric-icon.png')
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return ''
}

/**
 * Keep a restored window inside the work area of the display it sits on.
 *
 * Windows restores the previous "normal" bounds when a maximized window is
 * un-maximized. If those bounds are stale — a monitor was unplugged, the
 * resolution changed, or something resized the window while it was maximized —
 * the window comes back larger than the screen. The renderer then lays out at
 * the stale viewport and the status bar ends up behind the taskbar, with no
 * way to drag the window back into view. Clamping on every restore/resize makes
 * the window always land somewhere the user can reach.
 */
function clampToWorkArea(win: BrowserWindow): void {
  if (win.isDestroyed() || win.isMinimized() || win.isMaximized() || win.isFullScreen()) return

  const bounds = win.getBounds()
  const area = screen.getDisplayMatching(bounds).workArea
  const width = Math.min(bounds.width, area.width)
  const height = Math.min(bounds.height, area.height)
  const x = Math.min(Math.max(bounds.x, area.x), area.x + Math.max(0, area.width - width))
  const y = Math.min(Math.max(bounds.y, area.y), area.y + Math.max(0, area.height - height))

  if (x === bounds.x && y === bounds.y && width === bounds.width && height === bounds.height) return
  win.setBounds({ x, y, width, height })
}

function createWindow(): BrowserWindow {
  const iconPath = appIconPath()
  const window = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    backgroundColor: '#0A0B0D',
    // Kept in step with `<title>` in src/renderer/index.html. The document title
// wins the moment the page loads, so setting it here alone is dead code — that
// is why the packaged app's title bar read "Cryptoric Agent" long after this
// option said otherwise.
title: 'CryptoricAgent',
    ...(iconPath ? { icon: nativeImage.createFromPath(iconPath) } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(dirname_, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false
    }
  })

  window.once('ready-to-show', () => {
    clampToWorkArea(window)
    window.show()
  })

  // Re-clamp whenever the window returns to a normal size, and debounce the
  // resize path so a drag does not fight the user's window placement.
  let clampTimer: NodeJS.Timeout | null = null
  const scheduleClamp = (): void => {
    if (clampTimer) clearTimeout(clampTimer)
    clampTimer = setTimeout(() => clampToWorkArea(window), 120)
    clampTimer.unref?.()
  }
  window.on('unmaximize', () => clampToWorkArea(window))
  window.on('restore', () => clampToWorkArea(window))
  window.on('resize', scheduleClamp)
  window.on('move', scheduleClamp)
  // Any attached browser tab is a child view of this window's content, so it
  // has to be re-laid-out whenever the window changes size or position.
  window.on('resize', () => services?.browser.layout(window))
  window.on('closed', () => {
    if (clampTimer) clearTimeout(clampTimer)
  })

  void attachDesignReviewHooks(window)

  // Deny navigation and popups outright: the renderer must never navigate away.
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())

  if (process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadFile(join(dirname_, '../renderer/index.html'))
  }

  return window
}

/**
 * Development-only visual review hooks.
 *
 * `CRYPTORIC_SHOT=<dir>` renders the real window at each rail destination and
 * writes PNGs, so the design can be judged from the actual product surface
 * instead of from a mock. `CRYPTORIC_SHOT_SIZE=1280x720` sets the viewport, and
 * `CRYPTORIC_DEBUG_DUMP=1` prints a layout/console report. Both quit the app
 * when finished; neither is reachable without an explicit env var.
 */
async function attachDesignReviewHooks(window: BrowserWindow): Promise<void> {
  const shotDir = process.env['CRYPTORIC_SHOT']
  const dump = Boolean(process.env['CRYPTORIC_DEBUG_DUMP'])
  if (!shotDir && !dump) return

  // Development-only: answer approval prompts for the duration of a review run.
  //
  // Gated on `CRYPTORIC_SHOT_APPROVE` *and* `CRYPTORIC_SHOT`, so it cannot be
  // reached by setting one variable in a normal launch. Without it a scripted
  // review of the agent stalls at the first `write_file` and proves nothing about
  // the thing the review exists to look at. It grants nothing persistent — the
  // grant is the same session-scoped one the "Allow for this session" button
  // makes, and it dies with the process.
  if (process.env['CRYPTORIC_SHOT_APPROVE'] === '1' && shotDir) {
    const pump = setInterval(() => {
      for (const request of services?.approvals.list() ?? []) {
        const definition = services?.tools.get(request.toolId)
        if (definition && policyRef) policyRef.grantSession(definition.domain, 'allow')
        services?.approvals.resolve(request.id, true)
        console.log('CRYPTORIC_AUTOAPPROVE', request.toolId)
      }
    }, 40)
    pump.unref?.()
  }

  window.webContents.on('console-message', (_e, level, message) => {
    // 3 === error in Electron's console-message event.
    if (level >= 2) console.log('[renderer]', level, message)
  })

  await new Promise<void>((resolve) => {
    if (window.webContents.isLoading()) {
      window.webContents.once('did-finish-load', () => resolve())
    } else {
      resolve()
    }
  })
  await delay(1200)

  if (dump) {
    const report = await window.webContents.executeJavaScript(
      `JSON.stringify({
        bridge: typeof window.cryptoric === 'object',
        rail: document.querySelectorAll('.rail-btn').length,
        stage: !!document.querySelector('.stage'),
        cards: document.querySelectorAll('.card').length,
        overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        text: document.body.innerText.slice(0, 600)
      })`
    )
    console.log('CRYPTORIC_DUMP', report)
    if (!shotDir) {
      app.quit()
      return
    }
  }

  if (!shotDir) return

  const [width, height] = (process.env['CRYPTORIC_SHOT_SIZE'] ?? '1600x1000').split('x').map(Number)
  if (width && height) {
    // Resizing a maximized window corrupts its restore bounds, which is the
    // bug this clamp exists to contain — so drop out of maximized first.
    const wasMaximized = window.isMaximized()
    if (wasMaximized) window.unmaximize()
    await delay(200)
    window.setContentSize(width, height)
    clampToWorkArea(window)
    await delay(200)
  }
  mkdirSync(shotDir, { recursive: true })

  // Optionally open a real project first, so the workspace and runtime screens
  // are reviewed against live data rather than an empty state.
  const reviewProject = process.env['CRYPTORIC_SHOT_PROJECT']
  if (reviewProject) {
    await run(window, `window.cryptoric.project.open(${JSON.stringify(reviewProject)})`)
    await delay(1500)
  }

  // Optionally start a real task, so the execution timeline is reviewed with
  // live data rather than an empty state.
  const reviewTask = process.env['CRYPTORIC_SHOT_TASK']
  if (reviewTask) {
    await run(window, `window.cryptoric.agent.submit(${JSON.stringify(reviewTask)}, 'Review the project')`)
    // Wait for the task to reach a terminal state rather than guessing a delay.
    // A fixed wait captures the agent mid-run, which is exactly the half-finished
    // picture that made this look broken when it was merely early.
    const deadline = Date.now() + 180_000
    let settled = 'timeout'
    while (Date.now() < deadline) {
      const tasks = services?.agent.listTasks() ?? []
      const active = tasks.find((t) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.status))
      if (tasks.length > 0 && !active) {
        settled = tasks[0]?.status ?? 'unknown'
        break
      }
      await delay(400)
    }
    const done = services?.agent.listTasks()[0]
    console.log(
      'CRYPTORIC_TASK_DONE',
      JSON.stringify({
        status: settled,
        title: done?.title ?? null,
        changedPaths: done?.changedPaths ?? [],
        error: done?.error ?? null
      })
    )
    await delay(800)
  }

  const destinations: [string, string][] = [
    ['home', 'home'],
    ['agent', 'agent'],
    ['environment', 'environment'],
    ['workspace', 'files'],
    ['settings', 'settings'],
    ['palette', 'home']
  ]

  for (const [name, section] of destinations) {
    await run(window, `document.querySelector('[data-section="${section}"]')?.click()`)
    await delay(360)
    if (name === 'palette') {
      await run(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))`)
      await delay(360)
    }
    if (name === 'home' && process.env['CRYPTORIC_SHOT_RESIZE']) {
      // Prove the maximize -> restore path: the layout must still fill the
      // window exactly, with the status bar on screen and not behind the taskbar.
      window.maximize()
      await delay(600)
      window.unmaximize()
      await delay(600)
      writeFileSync(join(shotDir, 'restored.png'), (await window.webContents.capturePage()).toPNG())
      console.log('CRYPTORIC_SHOT', join(shotDir, 'restored.png'))
    }
    const image = await window.webContents.capturePage()
    writeFileSync(join(shotDir, `${name}.png`), image.toPNG())
    console.log('CRYPTORIC_SHOT', join(shotDir, `${name}.png`))
    // Text of the stage at this destination: proves what actually rendered,
    // which a screenshot alone cannot assert. The slice is generous because the
    // window is clamped to the work area, so anything below the fold is
    // otherwise unreachable in the captured PNG.
    const text = await window.webContents.executeJavaScript(
      `document.querySelector('.stage')?.innerText?.slice(0, 2600) ?? ''`
    )
    console.log('CRYPTORIC_STAGE_TEXT', name, JSON.stringify(text))
  }

  // The transient popup is too short-lived to catch by accident, and a popup
  // that never leaves is the failure nobody notices. Click the real control
  // that raises one, then prove both halves: it appears, and it is gone.
  if (process.env['CRYPTORIC_SHOT_TOAST']) {
    await run(window, `document.querySelector('[data-section="environment"]')?.click()`)
    await delay(400)
    await run(
      window,
      `[...document.querySelectorAll('button')].find((b) => /re-read os environment/i.test(b.textContent ?? ''))?.click()`
    )
    await delay(600)
    // Re-reading the environment probes every runtime, so the popup can arrive
    // seconds after the click. Poll rather than guess a delay.
    let shown = ''
    for (let i = 0; i < 60 && !shown; i++) {
      shown = await window.webContents.executeJavaScript(
        `document.querySelector('[role="status"]')?.innerText?.slice(0, 160) ?? ''`
      )
      if (!shown) await delay(200)
    }
    writeFileSync(join(shotDir, 'toast.png'), (await window.webContents.capturePage()).toPNG())
    console.log('CRYPTORIC_TOAST_SHOWN', JSON.stringify(shown))
    await delay(2600)
    const gone = await window.webContents.executeJavaScript(
      `document.querySelector('[role="status"]') ? 'still present' : 'dismissed'`
    )
    console.log('CRYPTORIC_TOAST_AFTER_TIMEOUT', gone)
  }

  app.quit()
}

/**
 * Move the userData directory across an application rename.
 *
 * "Already migrated" is judged by the files this app owns, not by whether the
 * folder is non-empty: Electron populates the new folder with `Cache`,
 * `GPUCache`, `Preferences` and friends on its own, so emptiness is never a
 * usable signal. If the move fails — a lock, a permission, a cross-device link —
 * the legacy directory is pinned as userData instead. Orphaning the credential
 * store to get a tidier folder name is a terrible trade.
 */
function migrateUserDataDir(legacyPath: string): void {
  const target = app.getPath('userData')
  if (!legacyPath || target === legacyPath) return
  if (!existsSync(legacyPath)) return

  const owned = (dir: string): boolean =>
    ['state.json', 'settings.json', 'credentials.json'].some((f) => existsSync(join(dir, f)))

  let alreadyMigrated = false
  try {
    alreadyMigrated = owned(target)
  } catch {
    alreadyMigrated = true
  }
  if (alreadyMigrated) return

  try {
    // rename() will not replace an existing directory on Windows. The target
    // holds no data of ours at this point, so removing it is safe.
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    renameSync(legacyPath, target)
  } catch (err) {
    console.warn('[userData] rename failed, keeping the previous location:', err)
    app.setPath('userData', legacyPath)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Chan's standing instructions for the tool-using turn.
 *
 * The honesty clauses are load-bearing, but they changed shape when the agent
 * loop landed. Chan can now genuinely run tools — so the rule is no longer
 * "never claim to have done anything" (which would make it lie by omission about
 * work it really did) but "report only what the tool results told you". A tool
 * that failed is reported as failed, and that is the whole contract.
 */


/** Evaluate renderer script for the review pass, logging rather than throwing. */
async function run(window: BrowserWindow, script: string): Promise<void> {
  try {
    await window.webContents.executeJavaScript(script)
  } catch (e: unknown) {
    console.log('CRYPTORIC_REVIEW_SCRIPT_FAILED', script.slice(0, 60), String(e))
  }
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'Workspace',
      submenu: [
        { label: 'Command Palette', accelerator: 'CmdOrCtrl+K', click: () => mainWindow?.webContents.send(CHANNELS.push, { type: 'log', level: 'info', message: 'command-palette', at: new Date().toISOString() }) },
        { type: 'separator' },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => mainWindow?.webContents.send(CHANNELS.push, { type: 'log', level: 'info', message: 'open-project', at: new Date().toISOString() }) },
        { type: 'separator' },
        isMac ? { role: 'close' as const } : { role: 'quit' as const }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// The app was named "Cryptoric Agent" until the rename to `CryptoricAgent`.
// Order matters and is not obvious: Electron fixes `userData` the first time it
// is read, and derives it from the app name *at that moment*. Reading
// `getPath('userData')` before `setName` therefore pins the pre-rename folder
// and the rename silently does nothing — the credential store, the settings and
// the project list stay behind. So set the name first and derive the legacy
// folder from `appData`, which is a fixed path.
app.setName('CryptoricAgent')
migrateUserDataDir(join(app.getPath('appData'), 'Cryptoric Agent'))

if (process.platform === 'win32') app.setAppUserModelId('dev.cryptoric.agent')

// Show the Cryptoric mark in the taskbar / dock rather than the Electron default.
const bootIcon = appIconPath()
if (bootIcon && process.defaultApp !== true) {
  try {
    app.dock?.setIcon(bootIcon)
  } catch {
    // `dock` is macOS-only; Windows uses the BrowserWindow icon above.
  }
}

// A second instance must focus the existing window rather than start a rival
// process that would compete for the same state file and tool registry.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(async () => {
    services = await boot()
    mainWindow = createWindow()
    buildMenu()

    // Reopen the folder that was open last session, then pick up a task it left
    // interrupted. Awaited *after* the window exists so the renderer is ready to
    // show the resumed task rather than missing its first events.
    await services.reopenLastProject()

    // Check the release feed once on launch, after the window exists so the
    // result has somewhere to go. Deliberately not awaited: a slow feed must not
    // delay the app becoming usable, and nothing is downloaded from here.
    //
    // `UpdateService` decides whether this build can check at all; an unpackaged
    // one reports `unsupported` rather than a false "up to date".
    setTimeout(() => {
      void bootUpdateCheck()
    }, 4000)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/**
 * Second pass guard.
 *
 * `before-quit` is deferred once so the flush can be awaited; without this the
 * second pass would defer again and the app would never actually quit.
 */
let shutdownComplete = false

app.on('before-quit', (event) => {
  // Deny every outstanding approval so no task is left waiting on a dialog that
  // can no longer be answered.
  services?.approvals.denyAll()
  services?.agent.stopAll()
  services?.processes.stopAll()
  services?.terminals.closeAll()
  // The transcript is the one piece of state that must outlive the process, so
  // it is flushed rather than left to whatever the queue gets around to.
  //
  // This used to be `void ...flush()`, which started the write and let the
  // process exit underneath it — the last turn of a conversation could simply
  // not be there on the next launch, with nothing to indicate why. Quitting is
  // now deferred until the flush resolves, and `shutdownComplete` lets the
  // second pass through.
  if (!shutdownComplete) {
    shutdownComplete = true
    event.preventDefault()
    void (async () => {
      try {
        await services?.conversation.flush()
      } finally {
        app.quit()
      }
    })()
    return
  }
  // Tear down tabs before the window goes away: a live WebContentsView keeps
  // its Chromium process alive, and temporary tabs delete their profile as they
  // close so nothing is left in the cache directory.
  void services?.browser.closeAll()
  ipcMain.removeAllListeners?.()
})