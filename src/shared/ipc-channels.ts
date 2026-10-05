/**
 * IPC channel names and result envelope.
 *
 * Deliberately dependency-free: the preload script runs in a sandboxed context
 * with no Node module resolution, so anything it imports must be inlined. Keeping
 * the channel names here — and the validation schemas in `ipc-schemas.ts` — means
 * the preload bundle carries only strings, and validation stays in the main
 * process where it belongs.
 */

export const CHANNELS = {
  // --- bootstrap
  appInfo: 'app:info',
  stateGet: 'state:get',
  stateSet: 'state:set',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsResolve: 'settings:resolve',
  settingsReset: 'settings:reset',
  settingsExport: 'settings:export',
  settingsImport: 'settings:import',
  settingsProjectOverride: 'settings:project-override',

  // --- projects
  projectOpen: 'project:open',
  projectClose: 'project:close',
  projectList: 'project:list',
  projectGaps: 'project:gaps',

  // --- environment
  envInspect: 'env:inspect',
  envInstall: 'env:install',
  envCancelInstall: 'env:cancel-install',
  envRefresh: 'env:refresh',
  envSnapshot: 'env:snapshot',

  // --- terminals
  terminalCreate: 'terminal:create',
  terminalWrite: 'terminal:write',
  terminalRefresh: 'terminal:refresh',
  terminalClose: 'terminal:close',
  terminalList: 'terminal:list',

  // --- processes / ports
  processStart: 'process:start',
  processList: 'process:list',
  processStop: 'process:stop',
  processRestart: 'process:restart',
  processLogs: 'process:logs',
  portScan: 'port:scan',

  // --- git
  gitStatus: 'git:status',
  gitDiff: 'git:diff',
  gitCheckpoint: 'git:checkpoint',
  gitCommit: 'git:commit',

  // --- files
  fileRead: 'file:read',
  fileWrite: 'file:write',
  fileSearch: 'file:search',
  fileTree: 'file:tree',

  // --- agent
  agentSubmit: 'agent:submit',
  agentList: 'agent:list',
  agentStop: 'agent:stop',
  agentPause: 'agent:pause',
  agentResume: 'agent:resume',
  conversationList: 'conversation:list',
  conversationClear: 'conversation:clear',
  approvalResolve: 'approval:resolve',
  approvalList: 'approval:list',
  toolsList: 'tools:list',

  // --- skills
  skillList: 'skill:list',
  skillSetEnabled: 'skill:set-enabled',
  skillRoute: 'skill:route',

  // --- permissions
  permissionList: 'permission:list',
  permissionSet: 'permission:set',

  // --- models
  modelsCatalog: 'models:catalog',
  modelsSelect: 'models:select',
  modelsAvailable: 'models:available',
  /** Re-fetch the model catalogue from a self-hosted provider server. */
  providerServerRefresh: 'models:provider-server-refresh',
  modelsSetBudget: 'models:set-budget',
  modelsSetProvider: 'models:set-provider',
  modelsVerifyKey: 'models:verify-key',
  modelsSetKey: 'models:set-key',
  /** Add or update a provider the user brought themselves. */
  modelsCustomSave: 'models:custom-save',
  modelsCustomRemove: 'models:custom-remove',

  // --- updates
  updatesStatus: 'updates:status',
  updatesCheck: 'updates:check',
  updatesDownload: 'updates:download',
  updatesInstall: 'updates:install',

  // --- diagnostics
  diagnostics: 'diagnostics:run',

  // --- main -> renderer pushes
  push: 'push:main-event',
  pushApproval: 'push:approval',
  pushLog: 'push:log',
  pushUpdate: 'push:update'
} as const

export type ChannelId = (typeof CHANNELS)[keyof typeof CHANNELS]

export interface IpcRequest {
  channel: string
  payload: unknown
}

/** Uniform result shape so the renderer never sees a raw rejection. */
export type IpcResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string }