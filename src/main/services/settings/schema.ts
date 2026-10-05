/**
 * Settings schema.
 *
 * Every user-visible preference is declared here, once, with its type, default,
 * validation rule and scope. Nothing else in the application is allowed to
 * invent a setting: the schema is the contract between the UI, persistence and
 * the engine, which is what makes "this setting actually changes behaviour"
 * checkable rather than aspirational.
 *
 * Two properties are enforced by construction rather than by convention:
 *
 *  - **No secrets live here.** A provider declares a `credentialKey` — a
 *    *reference* into the OS-encrypted credential store — never a key value.
 *    There is therefore no shape in this file that could hold one, so export,
 *    logs and a settings file on disk cannot leak a token.
 *  - **Every field is scoped.** `global` is overridden per project, so "use
 *    local Ollama for this repo" cannot be expressed as a global that quietly
 *    changes every other project.
 */

import { z } from 'zod'
import { FREE_DAILY_COINS } from '@shared/coins'

/**
 * Bumped whenever the persisted shape changes.
 *
 * Version 1 is the flat `state.json` shape that shipped first. Version 2 is this
 * grouped, validated, scoped schema; `migrateLegacyState` converts one into the
 * other without deleting the original file. Version 3 has the same shape — the
 * bump exists so `migrateAllowance` can retire the old 500-coin default on
 * installs that persisted it. A version bump that changes no shape is still a
 * version bump: it is what makes an existing file go through the migration
 * exactly once instead of never.
 */
export const SETTINGS_VERSION = 3

/**
 * Where a setting may be overridden.
 *
 * - `global`   — one value for the whole application
 * - `project`  — may be overridden per open project
 * - `session`  — lives for the current run only, never persisted
 * - `task`     — supplied by a running task (agent env vars, for example)
 */
export type SettingScope = 'global' | 'project' | 'session' | 'task'

// ------------------------------------------------------------- primitives
//
// Declared first: the schemas below reference them, and a `const` schema cannot
// be used before it is initialised.

export const ThemeSchema = z.enum(['system', 'dark', 'light'])
export const PermissionPresetSchema = z.enum(['read-only', 'safe', 'standard', 'full-access'])
export const ShellSchema = z.enum(['auto', 'powershell', 'cmd', 'bash', 'wsl'])
export const CursorStyleSchema = z.enum(['block', 'line', 'underline'])
export const ContextStrategySchema = z.enum(['minimal', 'balanced', 'thorough'])

/** A provider as configured by the user — never its credential. */
export const ProviderConfigSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** `openai-compatible` covers OpenRouter, OpenAI, Ollama, LM Studio, Z.ai, DeepSeek. */
  kind: z.enum(['openai-compatible', 'anthropic', 'google', 'custom']),
  baseUrl: z.string().url(),
  /**
   * Reference into the encrypted credential store, not the secret itself.
   * Null for providers that need no key (a local Ollama, typically).
   */
  credentialKey: z.string().min(1).nullable(),
  models: z.array(z.string().min(1)).default([]),
  /** Set when the user marked this provider as their own; BYOK spends nothing. */
  byok: z.boolean().default(false),
  enabled: z.boolean().default(true)
})

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>

/** A per-project override block. Only these keys may differ from global. */
export const ProjectOverrideSchema = z.object({
  defaultModel: z.string().min(1).optional(),
  instructions: z.string().max(20_000).optional(),
  skills: z.array(z.string().min(1)).optional(),
  permissionPreset: PermissionPresetSchema.optional(),
  shell: z.string().min(1).optional(),
  packageManager: z.string().min(1).optional(),
  startupScript: z.string().max(4000).optional(),
  enabledConnectors: z.array(z.string().min(1)).optional()
})

export type ProjectOverride = z.infer<typeof ProjectOverrideSchema>

// ---------------------------------------------------------------- sections

export const AppearanceSettingsSchema = z.object({
  theme: ThemeSchema.default('dark'),
  /**
   * Application-level UI scale. Applied as a CSS scale factor on the root
   * element, not browser zoom: zoom would reflow the webContents viewport and
   * break the window's layout assumptions.
   */
  scale: z.number().min(0.75).max(2).default(1),
  density: z.enum(['compact', 'default', 'relaxed']).default('default'),
  reducedMotion: z.boolean().default(false),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#22d3ee'),
  fontFamily: z.enum(['system', 'inter', 'mono-first']).default('system')
})

export const AgentSettingsSchema = z.object({
  defaultModel: z.string().min(1).default('local-default'),
  /** Let the gateway pick a model per task class instead of always using the default. */
  modelRouting: z.boolean().default(false),
  instructions: z.string().max(20_000).default(''),
  contextStrategy: ContextStrategySchema.default('balanced'),
  maxParallelAgents: z.number().int().min(1).max(8).default(1),
  backgroundTasks: z.boolean().default(false),
  maxAutomaticRetries: z.number().int().min(0).max(10).default(2),
  automaticTesting: z.boolean().default(true),
  automaticSecurityScan: z.boolean().default(false),
  automaticResearch: z.boolean().default(false),
  automaticDebugging: z.boolean().default(true)
})

export const PermissionSettingsSchema = z.object({
  preset: PermissionPresetSchema.default('standard'),
  /**
   * Global escape hatch. Still bounded by OS security: enabling this removes
   * Cryptoric's own prompts for ordinary development actions and nothing else.
   */
  fullAccess: z.boolean().default(false),
  /** Per-domain overrides; absent means "inherit the preset". */
  domains: z
    .record(
      z.enum([
        'fs.read',
        'fs.write',
        'fs.delete',
        'terminal.safe',
        'terminal.elevated',
        'terminal.destructive',
        'git.modify',
        'git.destructive',
        'network.write',
        'env.install',
        'env.modify'
      ]),
      z.enum(['allow', 'ask', 'deny'])
    )
    .default({})
})

export const EnvironmentSettingsSchema = z.object({
  /** When a required runtime is missing, offer to install it without a restart. */
  autoInstallRuntimes: z.boolean().default(true),
  /** `auto` defers to the project's lockfile. */
  packageManagerPreference: z.enum(['auto', 'npm', 'pnpm', 'yarn', 'bun', 'uv', 'poetry', 'cargo']).default('auto'),
  projectRuntimeIsolation: z.boolean().default(true),
  refreshEnvironmentOnInstall: z.boolean().default(true)
})

export const TerminalSettingsSchema = z.object({
  shell: ShellSchema.default('auto'),
  fontFamily: z.string().min(1).default('ui-monospace, monospace'),
  fontSize: z.number().int().min(8).max(32).default(13),
  scrollback: z.number().int().min(100).max(200_000).default(5000),
  cursorStyle: CursorStyleSchema.default('block'),
  copyOnSelect: z.boolean().default(false),
  shellIntegration: z.boolean().default(true),
  inheritEnvironment: z.boolean().default(true)
})

export const PrivacySettingsSchema = z.object({
  /** Never send project content to a cloud provider. */
  localOnlyMode: z.boolean().default(false),
  telemetry: z.boolean().default(false),
  externalResearch: z.boolean().default(true),
  projectIndexing: z.boolean().default(true),
  /** Scrub credential-shaped values before anything leaves the machine. */
  redactSecrets: z.boolean().default(true),
  excludedPaths: z.array(z.string().min(1)).default([])
})

export const NotificationSettingsSchema = z.object({
  agentCompleted: z.boolean().default(true),
  agentFailed: z.boolean().default(true),
  approvalRequired: z.boolean().default(true),
  backgroundTaskFinished: z.boolean().default(true),
  updateAvailable: z.boolean().default(true),
  modelUnavailable: z.boolean().default(true),
  coinsLow: z.boolean().default(true),
  runtimeInstalled: z.boolean().default(false),
  securityWarning: z.boolean().default(true),
  /** Desktop notification permission; in-app notices work regardless. */
  desktop: z.boolean().default(false)
})

export const SessionSettingsSchema = z.object({
  resumeTasks: z.boolean().default(true),
  restoreWorkspace: z.boolean().default(true),
  restoreApprovals: z.boolean().default(false)
})

export const UpdateSettingsSchema = z.object({
  channel: z.enum(['stable', 'beta', 'nightly']).default('stable'),
  checkAutomatically: z.boolean().default(true),
  /** Verify the download's checksum before staging it. */
  verifySignature: z.boolean().default(true)
})

export const UsageSettingsSchema = z.object({
  /**
   * Client-side display allowance only. The authoritative balance lives with the
   * account service; this is the cached ceiling used for the offline view and
   * must never be treated as a grant.
   */
  dailyAllowanceCoins: z.number().int().min(0).max(1_000_000).default(FREE_DAILY_COINS),
  /**
   * UTC day the one-time signup bonus was granted, or null if it never was.
   *
   * A day string rather than an instant so the comparison in `coins.ts` cannot
   * drift across a timezone boundary.
   */
  signupBonusGrantedOn: z.string().nullable().default(null),
  streakEnabled: z.boolean().default(false),
  lowBalanceWarningAt: z.number().int().min(0).default(5)
})

export const AdvancedSettingsSchema = z.object({
  debugLogging: z.boolean().default(false),
  logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('warn'),
  /** Confirm before running a project's startup script. */
  confirmStartupScript: z.boolean().default(true),
  discordRichPresence: z.boolean().default(false)
})

// ------------------------------------------------------------------ root

/**
 * Wrap a section schema so an absent value becomes the *fully populated*
 * defaults rather than `{}`.
 *
 * `Schema.default({})` substitutes the empty object verbatim without running the
 * section's own field defaults, which leaves holes in a fresh install: the file
 * parses, the schema is satisfied, and `appearance.scale` is `undefined`. The
 * function form parses the empty object properly, so every field is filled.
 */
function section<T extends z.ZodTypeAny>(schema: T): T {
  return schema.default(() => schema.parse({})) as unknown as T
}

export const SettingsSchema = z.object({
  appearance: section(AppearanceSettingsSchema),
  agent: section(AgentSettingsSchema),
  permissions: section(PermissionSettingsSchema),
  environment: section(EnvironmentSettingsSchema),
  terminal: section(TerminalSettingsSchema),
  privacy: section(PrivacySettingsSchema),
  notifications: section(NotificationSettingsSchema),
  sessions: section(SessionSettingsSchema),
  updates: section(UpdateSettingsSchema),
  usage: section(UsageSettingsSchema),
  advanced: section(AdvancedSettingsSchema),
  providers: z.array(ProviderConfigSchema).default([]),
  /** Keyed by absolute project root. Never mixed into global settings. */
  projectOverrides: z.record(z.string().min(1), ProjectOverrideSchema).default({}),
  onboardingComplete: z.boolean().default(false)
})

export type Settings = z.infer<typeof SettingsSchema>
export type SettingsSection = Exclude<keyof Settings, 'providers' | 'projectOverrides' | 'onboardingComplete'>

/** Every section a settings page may address. */
export const SETTINGS_SECTIONS: SettingsSection[] = [
  'appearance',
  'agent',
  'permissions',
  'environment',
  'terminal',
  'privacy',
  'notifications',
  'sessions',
  'updates',
  'usage',
  'advanced'
]

/** Declaration metadata, so the UI can render a page without a hand-written map. */
export interface SettingMeta {
  path: string
  scope: SettingScope
  /** True when the field influences runtime behaviour rather than presentation. */
  behavioural: boolean
  description: string
}

/**
 * Fields that actually drive the engine. The UI uses this to show which
 * settings change behaviour, and it is the list a reviewer should check
 * against the claim that "every setting does something".
 */
export const BEHAVIOURAL_SETTINGS: SettingMeta[] = [
  { path: 'permissions.preset', scope: 'project', behavioural: true, description: 'Baseline permission tier for every tool' },
  { path: 'permissions.fullAccess', scope: 'global', behavioural: true, description: 'Suppress prompts for ordinary development actions' },
  { path: 'permissions.domains', scope: 'global', behavioural: true, description: 'Per-domain allow/ask/deny overrides' },
  { path: 'agent.defaultModel', scope: 'project', behavioural: true, description: 'Model used when routing is off' },
  { path: 'agent.modelRouting', scope: 'global', behavioural: true, description: 'Choose a model per task class' },
  { path: 'agent.instructions', scope: 'project', behavioural: true, description: 'Persistent instructions included in agent context' },
  { path: 'agent.maxParallelAgents', scope: 'global', behavioural: true, description: 'Concurrent agent tasks' },
  { path: 'agent.backgroundTasks', scope: 'global', behavioural: true, description: 'Run long tasks without blocking the UI' },
  { path: 'agent.maxAutomaticRetries', scope: 'global', behavioural: true, description: 'Recovery attempts before a task is reported failed' },
  { path: 'agent.automaticTesting', scope: 'global', behavioural: true, description: 'Run the test suite after a change' },
  { path: 'agent.automaticSecurityScan', scope: 'global', behavioural: true, description: 'Scan changed files for secrets' },
  { path: 'agent.automaticDebugging', scope: 'global', behavioural: true, description: 'Enter the debug workflow on a failure' },
  { path: 'environment.autoInstallRuntimes', scope: 'global', behavioural: true, description: 'Offer to install a missing runtime' },
  { path: 'environment.packageManagerPreference', scope: 'project', behavioural: true, description: 'Package manager when not inferred from a lockfile' },
  { path: 'environment.projectRuntimeIsolation', scope: 'project', behavioural: true, description: 'Keep project runtimes out of global PATH' },
  { path: 'terminal.shell', scope: 'project', behavioural: true, description: 'Shell used by new sessions' },
  { path: 'terminal.inheritEnvironment', scope: 'global', behavioural: true, description: 'Whether sessions inherit the refreshed environment' },
  { path: 'privacy.localOnlyMode', scope: 'global', behavioural: true, description: 'Never send project content to a cloud provider' },
  { path: 'privacy.externalResearch', scope: 'global', behavioural: true, description: 'Permit fetching external documentation' },
  { path: 'privacy.redactSecrets', scope: 'global', behavioural: true, description: 'Scrub credential-shaped values before transmission' },
  { path: 'sessions.resumeTasks', scope: 'global', behavioural: true, description: 'Restore unfinished tasks on launch' },
  { path: 'usage.dailyAllowanceCoins', scope: 'global', behavioural: false, description: 'Cached display ceiling; the server is authoritative' },
  { path: 'usage.signupBonusGrantedOn', scope: 'global', behavioural: false, description: 'UTC day the one-time signup bonus was granted' }
]

export function defaultSettings(): Settings {
  return SettingsSchema.parse({})
}

/** Scope of a dotted path, used when deciding whether a project may override it. */
export function scopeOf(path: string): SettingScope {
  return BEHAVIOURAL_SETTINGS.find((s) => s.path === path)?.scope ?? 'global'
}