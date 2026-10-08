/**
 * Agent-process tools.
 *
 * Two tools ported from freebuff's agent runtime (`think_deeply`,
 * `write_todos`), adapted to Cryptoric's registry and context model.
 *
 * Neither touches a file or a network. What they do is structural: they give
 * the model a place to put the work that is not a tool call — the reasoning
 * before one, and the plan across many. Freebuff ships both because models
 * that externalise a plan stop re-deriving it every turn, and models that
 * write a thought out before acting make fewer confident-but-wrong tool calls.
 * The results are recorded into the conversation like any other tool output,
 * so the model can re-read its own list next turn instead of reconstructing it.
 */

import { z } from 'zod'
import type { PermissionDomain, ToolDescriptor } from '@shared/types'
import { describeSchema, type ToolContext, type ToolDefinition, type ToolResult } from '../registry'

const TOOL_META: Record<
  string,
  Pick<ToolDescriptor, 'category' | 'risk'> & { timeoutMs: number; mutates: boolean }
> = {
  think_deeply: { category: 'process', risk: 'safe', timeoutMs: 5_000, mutates: false },
  write_todos: { category: 'process', risk: 'safe', timeoutMs: 5_000, mutates: false }
}

const ok = (summary: string, data?: unknown): ToolResult => ({
  ok: true,
  summary,
  ...(data !== undefined ? { data } : {})
})

const fail = (
  summary: string,
  error: string,
  failureKind?: ToolResult['failureKind']
): ToolResult => ({ ok: false, summary, error, ...(failureKind ? { failureKind } : {}) })

const schema = z.object({
  thought: z.string().min(1).describe('The reasoning to record before acting on it.')
})

const todosSchema = z.object({
  todos: z
    .array(
      z.object({
        task: z.string().min(1).describe('Description of the task'),
        completed: z.boolean().describe('Whether the task is completed')
      })
    )
    .min(1)
    .max(50)
    .describe(
      'The full list with current status. Rewrite ALL todos each call — the new list replaces the old one, so items left out look finished.'
    )
})

export function buildAgentMetaTools(): ToolDefinition[] {
  return [
    {
      descriptor: {
        id: 'think_deeply',
        label: 'Think deeply',
        description:
          'Record your reasoning before a non-obvious action: which approach you chose and why, what you ruled out, what could go wrong. The thought is logged to the task timeline and kept in the conversation. Use it before a risky or multi-step operation; do not use it to narrate obvious steps.',
        dependsOn: [],
        tier: 'safe',
        platforms: ['*'],
        ...TOOL_META.think_deeply,
        inputSchema: describeSchema(schema)
      },
      domain: 'agent.self' as PermissionDomain,
      schema,
      execute: async (input: { thought: string }, ctx: ToolContext): Promise<ToolResult> => {
        const trimmed = input.thought.trim()
        if (trimmed.length === 0) {
          return fail('Empty thought', 'The thought was only whitespace.', 'invalid-args')
        }
        ctx.note(trimmed, 'info')
        return ok('Thought recorded.', { chars: trimmed.length })
      }
    },
    {
      descriptor: {
        id: 'write_todos',
        label: 'Write todos',
        description:
          'Write or update your task list for a multi-step job. Call it after you understand the request, to lay out ordered steps; call it again after each step to mark progress. Each call replaces the whole list, so always send every todo with its current completed flag — never mark a todo completed before its work is actually done.',
        dependsOn: [],
        tier: 'safe',
        platforms: ['*'],
        ...TOOL_META.write_todos,
        inputSchema: describeSchema(todosSchema)
      },
      domain: 'agent.self' as PermissionDomain,
      schema: todosSchema,
      execute: async (
        input: { todos: { task: string; completed: boolean }[] },
        ctx: ToolContext
      ): Promise<ToolResult> => {
        const todos = input.todos.map((t) => ({ task: t.task.trim(), completed: t.completed }))
        const done = todos.filter((t) => t.completed).length
        ctx.note(`Plan: ${done}/${todos.length} done`, 'info')
        const lines = todos.map((t) => `${t.completed ? '[x]' : '[ ]'} ${t.task}`)
        return ok(`${done}/${todos.length} todo(s) complete`, {
          todos,
          rendered: lines.join('\n')
        })
      }
    }
  ]
}
