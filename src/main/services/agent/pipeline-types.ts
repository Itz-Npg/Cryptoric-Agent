/**
 * Pipeline contract types.
 *
 * Extracted from `core.ts` so stage implementations can depend on the shape of a
 * stage without importing the runtime that executes them.
 */

import type { AgentRole, AgentTask, TimelineEntry } from '@shared/types'
import type { SessionGrant } from '@shared/session-time'
import type { ToolResult } from '../tools/registry'

/** The tool invocation surface handed to a stage. */
export interface StageToolApi {
  call(toolId: string, args: Record<string, unknown>): Promise<ToolResult>
  /**
   * Is a tool actually registered?
   *
   * Exists so a stage can tell "this build has no browser" apart from "this
   * build has a browser and the task did not need it". Inferring that by calling
   * a tool and catching the failure builds a confident answer on an error
   * message — which is how a stage ends up denying a capability the build has.
   */
  hasTool(toolId: string): boolean
}

export interface Stage {
  role: AgentRole
  name: string
  /** Ceiling on the permission tier this stage may reach. */
  maxTier: 'safe' | 'ask' | 'elevated' | 'destructive'
  run(ctx: StageContext): Promise<StageOutcome>
}

export interface StageContext {
  task: AgentTask
  signal: AbortSignal
  maxTier: 'safe' | 'ask' | 'elevated' | 'destructive'
  note(message: string, status?: TimelineEntry['status']): void
  call(toolId: string, args: Record<string, unknown>): Promise<ToolResult>
  /** @see StageToolApi.hasTool */
  hasTool(toolId: string): boolean
  workspaceRoots: string[]
  /** Assembled once per task from the routed skills. */
  skillContext: string
  selectedSkills: string[]
  /**
   * The session this task was bought with, or null when nothing was charged.
   *
   * Carried on the context rather than read from a module so the pipeline
   * cannot accidentally consult a *different* task's time: the value travels
   * with the task it belongs to.
   */
  session: SessionGrant | null
}

export interface StageOutcome {
  continue: boolean
  /**
   * `BLOCKED` and `PARTIAL` exist because "the agent stopped" is not the same as
   * "the agent succeeded". A run that ended without doing the work must be able
   * to say so; forcing it into FAILED or COMPLETED is how a no-op reported as
   * done in the first place.
   */
  status?: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'BLOCKED' | 'PARTIAL' | 'WAITING_FOR_USER'
  summary?: string
}

export type { AgentRole, AgentTask }
export type { SessionGrant } from '@shared/session-time'