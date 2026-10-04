/**
 * Tool registry.
 *
 * The agent's entire capability surface is a list of tools with declared inputs,
 * a permission domain, and a tier. Adding a capability is "one tool + one schema
 * + one permission + one skill", not an edit across the agent core.
 *
 * External tools (MCP servers, plugin packs) register through the same
 * `register()` path, so nothing in the agent core is aware of the origin of a
 * tool. That is what keeps the extension boundary honest: a third-party tool is
 * subject to exactly the same policy evaluation as a built-in one.
 */

import { z } from 'zod'
import type {
  PermissionDomain,
  PermissionTier,
  ToolArtifact,
  ToolDescriptor,
  ToolFailureKind
} from '@shared/types'

export interface ToolContext {
  /** Currently open project root, or null. */
  projectRoot: string | null
  /** Extra environment for the highest-precedence TASK layer. */
  taskEnv: Record<string, string> | null
  /** Cooperative cancellation supplied by the orchestrator. */
  signal: AbortSignal
  /** Emit a timeline entry without ending the turn. */
  note(message: string, status?: 'ok' | 'error' | 'info'): void
  /** Id of the owning task, for artifact and audit attribution. */
  taskId?: string | null
  /** Ceiling the caller granted; a tool may never exceed it. */
  grantedTier?: PermissionTier
}

export interface ToolInvocation<A = unknown> {
  toolId: string
  args: A
  /** Capability granted by the caller; the tool may not exceed it. */
  grantedTier: PermissionTier
}

export interface ToolResult {
  ok: boolean
  /** Human-readable summary for the transcript. */
  summary: string
  /** Structured payload for the agent to reason over. */
  data?: unknown
  error?: string
  /** Set when the agent must stop and wait for a human. */
  requiresApproval?: boolean
  /** Process exit code, for tools that shell out. */
  exitCode?: number | null
  /** Files produced, so the agent can reference them by path. */
  artifacts?: ToolArtifact[]
  /** Non-fatal problems the agent should know about but that did not stop it. */
  warnings?: string[]
  /** Free-form provenance: versions, pids, snapshot ids. */
  metadata?: Record<string, unknown>
  /** Set by the runtime; a tool should not set this itself. */
  failureKind?: ToolFailureKind
}

export interface ToolDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  descriptor: ToolDescriptor
  /** Permission domain this tool operates under. */
  domain: PermissionDomain
  schema: S
  execute(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>
  /** Tools that must succeed before this one (shown in the UI). */
  dependsOn?: string[]
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.descriptor.id)) {
      throw new Error(`Tool already registered: ${tool.descriptor.id}`)
    }
    this.tools.set(tool.descriptor.id, tool)
  }

  registerAll(tools: ToolDefinition[]): void {
    for (const t of tools) this.register(t)
  }

  has(id: string): boolean {
    return this.tools.has(id)
  }

  get(id: string): ToolDefinition | null {
    return this.tools.get(id) ?? null
  }

  list(): ToolDescriptor[] {
    return [...this.tools.values()]
      .map((t) => t.descriptor)
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  /** Topologically order tools so dependencies are available first. */
  ordered(): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    const visit = (id: string, stack: Set<string>): void => {
      if (seen.has(id) || stack.has(id)) return
      stack.add(id)
      const tool = this.tools.get(id)
      for (const dep of tool?.dependsOn ?? []) visit(dep, stack)
      stack.delete(id)
      seen.add(id)
      out.push(id)
    }
    for (const id of this.tools.keys()) visit(id, new Set())
    return out
  }

  /** Validate raw args; a mismatch is a tool error, never a silent coercion. */
  parse(id: string, args: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
    const tool = this.tools.get(id)
    if (!tool) return { ok: false, error: `Unknown tool: ${id}` }
    const parsed = tool.schema.safeParse(args ?? {})
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')
      return { ok: false, error: `Invalid arguments for ${id} — ${issues}` }
    }
    return { ok: true, value: parsed.data }
  }
}

/**
 * Describe a zod schema as JSON-Schema-ish for the UI. Only the subset of
 * features the built-in tools use is supported, which keeps the renderer free of
 * a schema-rendering dependency.
 */
export function describeSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as {
    typeName?: string
    innerType?: z.ZodTypeAny
    valueType?: z.ZodTypeAny
    type?: z.ZodTypeAny
    checks?: { kind: string; value: number }[]
  }
  switch (def.typeName) {
    case 'ZodString': {
      const checks = def.checks ?? []
      return {
        type: 'string',
        ...(checks.some((c) => c.kind === 'min') ? { minLength: checks.find((c) => c.kind === 'min')?.value } : {}),
        ...(checks.some((c) => c.kind === 'max') ? { maxLength: checks.find((c) => c.kind === 'max')?.value } : {})
      }
    }
    case 'ZodNumber':
      return { type: 'number' }
    case 'ZodBoolean':
      return { type: 'boolean' }
    case 'ZodArray':
      return { type: 'array', items: def.type ? describeSchema(def.type) : {} }
    case 'ZodObject':
      return {
        type: 'object',
        properties: shapeToRecord((schema as unknown as z.ZodObject<z.ZodRawShape>).shape),
        required: requiredKeys((schema as unknown as z.ZodObject<z.ZodRawShape>).shape)
      }
    case 'ZodEnum':
      return { type: 'string', enum: ((def.valueType as { _def?: { values?: string[] } })?._def?.values ?? []) as string[] }
    case 'ZodOptional':
      return def.innerType ? describeSchema(def.innerType) : {}
    case 'ZodDefault':
      return def.innerType ? describeSchema(def.innerType) : {}
    case 'ZodNullable':
      return def.innerType ? describeSchema(def.innerType) : {}
    default:
      return {}
  }
}

function shapeToRecord(shape: z.ZodRawShape): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(shape)) out[key] = describeSchema(value)
  return out
}

function requiredKeys(shape: z.ZodRawShape): string[] {
  return Object.entries(shape)
    .filter(([, v]) => {
      const name = (v as z.ZodTypeAny)._def?.typeName
      return name !== 'ZodOptional' && name !== 'ZodDefault'
    })
    .map(([key]) => key)
}

export function describeTool(tool: ToolDefinition): ToolDescriptor {
  return { ...tool.descriptor, inputSchema: describeSchema(tool.schema) }
}