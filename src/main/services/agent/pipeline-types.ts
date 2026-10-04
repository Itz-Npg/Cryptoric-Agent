/**
 * Pipeline contract types.
 *
 * Extracted from `core.ts` so stage implementations can depend on the shape of a
 * stage without importing the runtime that executes them.
 */

import type { AgentRole, AgentTask, TimelineEntry } from '@shared/types'
import type { ToolResult } from '../tools/registry'

/** The tool invocation surface handed to a stage. */
export interface StageToolApi {
  call(toolId: string, args: Record<string, unknown>): Promise<ToolResult>
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
  workspaceRoots: string[]
  /** Assembled once per task from the routed skills. */
  skillContext: string
  selectedSkills: string[]
}

export interface StageOutcome {
  continue: boolean
  status?: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'WAITING_FOR_USER'
  summary?: string
}

export type { AgentRole, AgentTask }