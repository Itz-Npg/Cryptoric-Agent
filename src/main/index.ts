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

import { app, BrowserWindow, dialog, ipcMain, nativeImage, safeStorage, shell, Menu } from 'electron'
import { existsSync } from 'node:fs'
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
import { buildEnvironmentTools } from './services/tools/builtin/environment'
import { AgentRuntime } from './services/agent/core'
import { buildPipeline } from './services/agent/stages'
import { IpcRouter } from './ipc/router'
import { createStore, CredentialStore, type AppState } from './services/store'
import { detectProject, computeGaps } from './services/project/detect'
import { FileService } from './services/fs/files'
import { GitService } from './services/git/service'
import type { ProjectProfile, ToolStatus, MainEvent } from '@shared/types'

const dirname_ = fileURLToPath(new URL('.', import.meta.url))

let mainWindow: BrowserWindow | null = null

interface Services {
  env: EnvironmentManager
  terminals: TerminalSessionManager
  processes: ProcessSupervisor
  tools: ToolRegistry
  policy: PermissionPolicy
  approvals: ApprovalQueue
  skills: SkillRegistry
  agent: AgentRuntime
  router: IpcRouter
  store: ReturnType<typeof createStore>
  credentials: CredentialStore
  getProject(): ProjectProfile | null
}

let services: Services | null = null

function push(event: MainEvent): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(CHANNELS.push, event)
}

async function boot(): Promise<Services> {
  const userDataDir = app.getPath('userData')
  const managedRoot = join(userDataDir, 'tools', 'cryptoric-tools')
  const scratchDir = join(userDataDir, 'tmp')

  const store = createStore(userDataDir)
  const state = await store.load()

  const policy = new PermissionPolicy(DEFAULT_PERMISSION_RULES)
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

  const tools = new ToolRegistry()
  tools.registerAll(buildEnvironmentTools({ env, terminals, processes, authorize }))

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

  const agent = new AgentRuntime(
    {
      tools,
      policy,
      approvals,
      skills,
      skillTokenBudget: 6000,
      maxSkillsPerTask: 4,
      getProjectRoot: () => project?.root ?? null,
      events: {
        timeline: (entry) => push({ type: 'timeline', entry }),
        task: (task) => push({ type: 'task', task }),
        toolResult: () => undefined,
        say: (text) => push({ type: 'log', level: 'info', message: text, at: new Date().toISOString() })
      }
    },
    buildPipeline({
      tools: { call: async () => ({ ok: false, summary: 'unavailable', error: 'not wired' }) },
      getProject: () => project,
      probeRuntime: async (toolId) => {
        const s = await env.probeTool(toolId)
        return { state: s.state, version: s.version, detail: s.detail }
      }
    })
  )

  const router = new IpcRouter({
    getTrustedWebContents: () => mainWindow?.webContents ?? null,
    policy,
    approvals
  })

  registerRoutes(router, {
    env,
    terminals,
    processes,
    tools,
    policy,
    approvals,
    skills,
    agent,
    store,
    files,
    git,
    getProject: () => project,
    setProject: async (root) => {
      const detected = await detectProject(root)
      project = detected
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
      return detected
    },
    push
  })

  const credentials = new CredentialStore(join(userDataDir, 'credentials.json'), {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (v) => safeStorage.encryptString(v),
    decryptString: (b) => safeStorage.decryptString(b)
  })

  return {
    env, terminals, processes, tools, policy, approvals, skills, agent, router, store, credentials,
    getProject: () => project
  }
}

interface RouteDeps {
  env: EnvironmentManager
  terminals: TerminalSessionManager
  processes: ProcessSupervisor
  tools: ToolRegistry
  policy: PermissionPolicy
  approvals: ApprovalQueue
  skills: SkillRegistry
  agent: AgentRuntime
  store: ReturnType<typeof createStore>
  files: FileService
  git: GitService
  getProject(): ProjectProfile | null
  setProject(root: string): Promise<ProjectProfile>
  push(event: MainEvent): void
}

function registerRoutes(router: IpcRouter, deps: RouteDeps): void {
  const { env, terminals, processes, tools, policy, approvals, skills, agent, store, files, git } = deps

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

  // -------------------------------------------------------------- projects
  router.register(CHANNELS.projectOpen, {
    domain: 'fs.read',
    requiresApproval: false,
    handler: async (args: { root: string }) => {
      const selected = args.root || (await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] })).filePaths[0]
      if (!selected) throw new Error('No directory selected')
      return deps.setProject(selected)
    }
  })
  router.register(CHANNELS.projectClose, { handler: () => null })
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
    handler: (args: { prompt: string; title?: string; role?: Parameters<typeof agent.submit>[0]['role'] }) =>
      agent.submit({
        title: args.title ?? args.prompt.slice(0, 60),
        prompt: args.prompt,
        role: args.role ?? 'PROJECT_ANALYZER'
      })
  })
  router.register(CHANNELS.agentList, { handler: () => agent.listTasks() })
  router.register(CHANNELS.agentStop, { handler: (args: { taskId: string }) => agent.stop(args.taskId) })
  router.register(CHANNELS.agentPause, { handler: (args: { taskId: string }) => agent.pause(args.taskId) })
  router.register(CHANNELS.agentResume, { handler: (args: { taskId: string }) => agent.resume(args.taskId) })
  router.register(CHANNELS.toolsList, { handler: () => tools.list() })

  // ------------------------------------------------------------- approvals
  router.register(CHANNELS.approvalList, { handler: () => approvals.list() })
  router.register(CHANNELS.approvalResolve, {
    domain: 'terminal.safe',
    requiresApproval: false,
    handler: (args: { id: string; approved: boolean; remember?: boolean }) =>
      approvals.resolve(args.id, args.approved)
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

  // ----------------------------------------------------------- diagnostics
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
        }
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

function createWindow(): BrowserWindow {
  const iconPath = appIconPath()
  const window = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    backgroundColor: '#0A0B0D',
    title: 'Cryptoric Agent',
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

  window.once('ready-to-show', () => window.show())

  if (process.env['CRYPTORIC_DEBUG_DUMP']) {
    window.webContents.on('console-message', (_e, level, message) => console.log('[renderer]', level, message))
    window.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void window.webContents
          .executeJavaScript(
            `JSON.stringify({
              bridge: typeof window.cryptoric === 'object',
              panes: document.querySelectorAll('.pane').length,
              ledgers: document.querySelectorAll('.ledger-row').length,
              text: document.body.innerText.slice(0, 400)
            })`
          )
          .then((v) => {
            console.log('CRYPTORIC_DUMP', v)
            app.quit()
          })
          .catch((e: unknown) => {
            console.log('CRYPTORIC_DUMP_ERROR', String(e))
            app.quit()
          })
      }, 5000)
    })
  }

  // Deny navigation and popups outright: the renderer must never navigate away.
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
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

app.setName('Cryptoric Agent')
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

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  // Deny every outstanding approval so no task is left waiting on a dialog that
  // can no longer be answered.
  services?.approvals.denyAll()
  services?.agent.stopAll()
  services?.processes.stopAll()
  services?.terminals.closeAll()
  ipcMain.removeAllListeners?.()
})