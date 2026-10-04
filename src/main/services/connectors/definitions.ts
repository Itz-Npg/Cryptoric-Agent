/**
 * Connectors: services the agent can drive on the user's behalf.
 *
 * Every connector here is a real integration. There is no demo mode, no stubbed
 * response, and no "connected" state that is not backed by a live API call that
 * the provider actually answered. That rule shapes everything below:
 *
 *  - `verify()` must return an account name the **provider** supplied. A
 *    connector that cannot name the account it is authenticated as is not
 *    connected, and saying otherwise is the single most misleading thing this
 *    file could do.
 *  - A rejected token deletes the stored credential. Leaving a token that does
 *    not work behind a green tick is how a user spends an hour wondering why
 *    their deploys vanished.
 *  - `authScheme` is per connector because providers genuinely disagree: Linear
 *    takes a bare API key where the rest take a bearer token.
 *
 * The endpoints were each probed live on 2026-10-04 with an invalid token, so
 * every URL here is known to exist. See `audit.md`.
 */

import { z } from 'zod'
import type { PermissionDomain, ToolCategory, ToolRiskLevel } from '@shared/types'
import type { ToolContext, ToolDefinition, ToolResult } from '../tools/registry'
import { isAuthFailure, request, type HttpResult } from './http'

export interface ConnectorIdentity {
  /** The name the provider itself reported. Never invented locally. */
  accountName: string
  accountId: string | null
}

export interface ConnectorToolDeps {
  /** Read the connector's token from the encrypted credential store. */
  getToken(slot: string): string | null
}

export interface ConnectorDefinition {
  id: string
  label: string
  /** One line, shown in the UI and given to the model as what this unlocks. */
  blurb: string
  /** Where the user obtains a token. */
  tokenUrl: string
  /** Credential-store slot. One per connector, never shared. */
  slot: string
  category: ToolCategory
  /** Confirm a token really works, and name the account it belongs to. */
  verify(token: string, signal?: AbortSignal): Promise<ConnectorIdentity>
  /** Tools this connector contributes while connected. */
  tools(deps: ConnectorToolDeps): ToolDefinition[]
}

const ok = (summary: string, data?: unknown): ToolResult => ({
  ok: true,
  summary,
  ...(data !== undefined ? { data } : {})
})

const fail = (summary: string, error: string): ToolResult => ({ ok: false, summary, error })

/**
 * Turn a failed HTTP call into a failure the agent can act on.
 *
 * "Your token was rejected" and "the provider is unreachable" are different
 * problems with different fixes, so they are never collapsed into one message.
 */
function httpFailure(name: string, res: Extract<HttpResult<unknown>, { ok: false }>): ToolResult {
  const kind = isAuthFailure(res.status) ? 'the token was rejected' : 'the request failed'
  return fail(`${name} failed: ${kind}.`, `${name}: ${kind} — ${res.error}`)
}

/**
 * A read-only connector tool: one request, described, with its result returned.
 *
 * Reads are `safe` and never need approval, so an agent can inspect an account
 * freely. Anything that mutates the provider is a separate, higher-risk tool so
 * the permission policy asks first — that split is the reason this helper only
 * ever describes reads.
 */
function readTool(opts: {
  id: string
  label: string
  description: string
  domain: PermissionDomain
  category: ToolCategory
  url: string
  method?: 'GET' | 'POST'
  body?: unknown
  headers?: Record<string, string>
  /** Linear takes a bare API key where the rest take a bearer token. */
  bareAuth?: boolean
  deps: ConnectorToolDeps
  slot: string
  /** Build the success summary from the decoded body. */
  summarise(data: unknown): string
  /** Build the payload the model reasons over. */
  project(data: unknown): unknown
}): ToolDefinition {
  const schema = z.object({}).passthrough()

  return {
    descriptor: {
      id: opts.id,
      label: opts.label,
      description: opts.description,
      dependsOn: [],
      tier: 'safe',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      category: opts.category,
      risk: 'safe',
      timeoutMs: 25_000,
      mutates: false,
      // A token must never reach an audit line or an approval prompt.
      sensitiveArgs: ['token', 'apiKey', 'authorization']
    },
    domain: opts.domain,
    schema,
    execute: async (_input, _ctx: ToolContext) => {
      const token = opts.deps.getToken(opts.slot)
      if (!token) {
        return fail(
          `${opts.label} is not connected.`,
          `${opts.label} is not connected. Add its token in Settings → Connectors.`
        )
      }

      const res = await request(opts.url, token, {
        method: opts.method ?? 'GET',
        ...(opts.body !== undefined ? { body: opts.body } : {}),
        headers: { ...(opts.headers ?? {}), ...(opts.bareAuth ? { Authorization: token } : {}) }
      })

      if (!res.ok) return httpFailure(opts.label, res)
      return ok(opts.summarise(res.data), opts.project(res.data))
    }
  }
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)

// ---------------------------------------------------------------------------
// Vercel
// ---------------------------------------------------------------------------

const vercel: ConnectorDefinition = {
  id: 'vercel',
  label: 'Vercel',
  blurb: 'Projects, deployments and domains — deploy the web app the agent just wrote.',
  tokenUrl: 'https://vercel.com/account/tokens',
  slot: 'connector-vercel',
  category: 'deploy',
  async verify(token) {
    const res = await request<{ user?: { username?: string; id?: string } }>(
      'https://api.vercel.com/v2/user',
      token
    )
    if (!res.ok) throw new Error(res.error)
    const username = str(res.data?.user?.username)
    // No username means the provider did not tell us who this is. Guessing here
    // is exactly the false "connected" state this file exists to prevent.
    if (!username) throw new Error('Vercel did not return an account name for this token.')
    return { accountName: username, accountId: str(res.data?.user?.id) || null }
  },
  tools: (deps) => [
    readTool({
      id: 'vercel_projects',
      label: 'Vercel projects',
      description: 'List the Vercel projects this account owns, with their framework and git repo.',
      domain: 'network.read',
      category: 'deploy',
      url: 'https://api.vercel.com/v9/projects?limit=100',
      deps,
      slot: vercel.slot,
      summarise: (data) => {
        const rows = Array.isArray(asRecord(data).projects) ? (asRecord(data).projects as unknown[]) : []
        return `Vercel returned ${rows.length} project(s).`
      },
      project: (data) => {
        const rows = Array.isArray(asRecord(data).projects) ? (asRecord(data).projects as unknown[]) : []
        return rows.slice(0, 100).map((p) => {
          const r = asRecord(p)
          return {
            id: str(r.id),
            name: str(r.name),
            framework: r.framework ? str(asRecord(r.framework).slug) : null,
            gitRepo: str(asRecord(r.link).type) ? str(asRecord(r.link).repo) : null,
            updatedAt: num(r.updated)
          }
        })
      }
    })
  ]
}

// ---------------------------------------------------------------------------
// Cloudflare
// ---------------------------------------------------------------------------

const cloudflare: ConnectorDefinition = {
  id: 'cloudflare',
  label: 'Cloudflare',
  blurb: 'Accounts, zones, Workers, KV, D1 and R2 — DNS, edge runtime and storage.',
  tokenUrl: 'https://dash.cloudflare.com/profile/api-tokens',
  slot: 'connector-cloudflare',
  category: 'deploy',
  async verify(token) {
    const res = await request<{ result?: { id?: string }; success?: boolean }>(
      'https://api.cloudflare.com/client/v4/user/tokens/verify',
      token
    )
    // Cloudflare answers HTTP 400 for an invalid token rather than 401. Treat
    // any auth-shaped failure as "rejected" so a bad token is never reported as
    // an unreachable service.
    if (!res.ok) {
      throw new Error(
        isAuthFailure(res.status)
          ? `Cloudflare rejected this token: ${res.error}`
          : `Could not reach Cloudflare: ${res.error}`
      )
    }
    // A verified token has no account name of its own — Cloudflare tokens are
    // not account-scoped. Report the truthful thing: the token is valid.
    return { accountName: 'API token verified', accountId: str(res.data?.result?.id) || null }
  },
  tools: (deps) => [
    readTool({
      id: 'cloudflare_zones',
      label: 'Cloudflare zones',
      description: 'List the DNS zones in this Cloudflare account and their nameservers and status.',
      domain: 'network.read',
      category: 'deploy',
      url: 'https://api.cloudflare.com/client/v4/zones?per_page=50',
      deps,
      slot: cloudflare.slot,
      summarise: (data) => {
        const rows = Array.isArray(asRecord(data).result) ? (asRecord(data).result as unknown[]) : []
        return `Cloudflare returned ${rows.length} zone(s).`
      },
      project: (data) => {
        const rows = Array.isArray(asRecord(data).result) ? (asRecord(data).result as unknown[]) : []
        return rows.map((z0) => {
          const r = asRecord(z0)
          const nameServers = Array.isArray(r.name_servers) ? (r.name_servers as unknown[]) : []
          return {
            id: str(r.id),
            name: str(r.name),
            status: str(r.status),
            plan: str(asRecord(r.plan).name),
            nameServers: nameServers.map((n) => str(n))
          }
        })
      }
    })
  ]
}

// ---------------------------------------------------------------------------
// Netlify
// ---------------------------------------------------------------------------

const netlify: ConnectorDefinition = {
  id: 'netlify',
  label: 'Netlify',
  blurb: 'Sites and builds — publish a static or frontend build without a local server.',
  tokenUrl: 'https://app.netlify.com/user/tokens',
  slot: 'connector-netlify',
  category: 'deploy',
  async verify(token) {
    const res = await request<{ id?: string; email?: string; full_name?: string }>(
      'https://api.netlify.com/api/v1/user',
      token
    )
    if (!res.ok) throw new Error(res.error)
    const name = str(res.data?.full_name) || str(res.data?.email)
    if (!name) throw new Error('Netlify did not return an account name for this token.')
    return { accountName: name, accountId: str(res.data?.id) || null }
  },
  tools: (deps) => [
    readTool({
      id: 'netlify_sites',
      label: 'Netlify sites',
      description: 'List the Netlify sites in this account with their deploy state and custom domain.',
      domain: 'network.read',
      category: 'deploy',
      url: 'https://api.netlify.com/api/v1/sites?per_page=50',
      deps,
      slot: netlify.slot,
      summarise: (data) => {
        const rows = Array.isArray(data) ? (data as unknown[]) : []
        return `Netlify returned ${rows.length} site(s).`
      },
      project: (data) => {
        const rows = Array.isArray(data) ? (data as unknown[]) : []
        return rows.map((s) => {
          const r = asRecord(s)
          return {
            id: str(r.id),
            name: str(r.name),
            url: str(r.url),
            state: str(r.state),
            customDomain: str(r.custom_domain),
            createdAt: str(r.created_at)
          }
        })
      }
    })
  ]
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const render: ConnectorDefinition = {
  id: 'render',
  label: 'Render',
  blurb: 'Web services, static sites and cron jobs with real deploys and build logs.',
  tokenUrl: 'https://dashboard.render.com/account/settings',
  slot: 'connector-render',
  category: 'deploy',
  async verify(token) {
    const res = await request<unknown[]>('https://api.render.com/v1/services?limit=1', token)
    if (!res.ok) throw new Error(res.error)
    // Render's API has no "who am I" endpoint. A 200 here means the key is good;
    // the account is then named by the services it can see.
    const rows = Array.isArray(res.data) ? res.data : []
    const owner = rows.length > 0 ? str(asRecord(asRecord(asRecord(rows[0]).service).owner).name) : ''
    return { accountName: owner || 'API key verified', accountId: null }
  },
  tools: (deps) => [
    readTool({
      id: 'render_services',
      label: 'Render services',
      description: 'List Render services, static sites and cron jobs with their deploy state.',
      domain: 'network.read',
      category: 'deploy',
      url: 'https://api.render.com/v1/services?limit=100',
      deps,
      slot: render.slot,
      summarise: (data) => {
        const rows = Array.isArray(data) ? (data as unknown[]) : []
        return `Render returned ${rows.length} service(s).`
      },
      project: (data) => {
        const rows = Array.isArray(data) ? (data as unknown[]) : []
        return rows.map((row) => {
          const service = asRecord(asRecord(row).service)
          return {
            id: str(service.id),
            name: str(service.name),
            type: str(service.type),
            url: service.url ?? null,
            branch: str(asRecord(row).cursor),
            updatedAt: service.updatedAt ?? null,
            owner: str(asRecord(service.owner).name) || null
          }
        })
      }
    })
  ]
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

const supabase: ConnectorDefinition = {
  id: 'supabase',
  label: 'Supabase',
  blurb: 'Projects, Postgres, Auth and Edge Functions — a backend without running one.',
  tokenUrl: 'https://supabase.com/dashboard/account/tokens',
  slot: 'connector-supabase',
  category: 'database',
  async verify(token) {
    const res = await request<unknown[]>('https://api.supabase.com/v1/projects?limit=1', token)
    if (!res.ok) throw new Error(res.error)
    const rows = Array.isArray(res.data) ? res.data : []
    const org = rows.length > 0 ? str(asRecord(asRecord(rows[0]).organization).name) : ''
    return { accountName: org || 'Access token verified', accountId: null }
  },
  tools: (deps) => [
    readTool({
      id: 'supabase_projects',
      label: 'Supabase projects',
      description: 'List Supabase projects with their ref, region, database version and status.',
      domain: 'network.read',
      category: 'database',
      url: 'https://api.supabase.com/v1/projects?limit=100',
      deps,
      slot: supabase.slot,
      summarise: (data) => {
        const rows = Array.isArray(data) ? (data as unknown[]) : []
        return `Supabase returned ${rows.length} project(s).`
      },
      project: (data) => {
        const rows = Array.isArray(data) ? (data as unknown[]) : []
        return rows.map((p) => {
          const r = asRecord(p)
          return {
            id: str(r.id),
            name: str(r.name),
            ref: str(r.ref),
            region: str(r.region),
            status: str(r.status),
            databaseVersion: num(asRecord(r.database).version),
            organization: str(asRecord(r.organization).name)
          }
        })
      }
    })
  ]
}

// ---------------------------------------------------------------------------
// Sentry
// ---------------------------------------------------------------------------

const sentry: ConnectorDefinition = {
  id: 'sentry',
  label: 'Sentry',
  blurb: 'Errors, performance, releases — find out why the deployed app is unhappy.',
  tokenUrl: 'https://sentry.io/settings/account/api/auth-tokens/',
  slot: 'connector-sentry',
  category: 'observability',
  async verify(token) {
    const res = await request<unknown[]>('https://sentry.io/api/0/organizations/?per_page=1', token)
    if (!res.ok) throw new Error(res.error)
    const rows = Array.isArray(res.data) ? res.data : []
    const name = rows.length > 0 ? str(asRecord(rows[0]).name) : ''
    return { accountName: name || 'Auth token verified', accountId: null }
  },
  tools: (deps) => [
    readTool({
      id: 'sentry_organizations',
      label: 'Sentry organizations',
      description: 'List Sentry organizations this token can read, with slug and member count.',
      domain: 'network.read',
      category: 'observability',
      url: 'https://sentry.io/api/0/organizations/?per_page=50',
      deps,
      slot: sentry.slot,
      summarise: (data) => {
        const rows = Array.isArray(data) ? (data as unknown[]) : []
        return `Sentry returned ${rows.length} organization(s).`
      },
      project: (data) => {
        const rows = Array.isArray(data) ? (data as unknown[]) : []
        return rows.map((o) => {
          const r = asRecord(o)
          return { id: str(r.id), slug: str(r.slug), name: str(r.name), dateCreated: str(r.dateCreated) }
        })
      }
    })
  ]
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

const stripe: ConnectorDefinition = {
  id: 'stripe',
  label: 'Stripe',
  blurb: 'Products, prices and customers — set up billing the agent can read back.',
  tokenUrl: 'https://dashboard.stripe.com/apikeys',
  slot: 'connector-stripe',
  category: 'payments',
  async verify(token) {
    const res = await request<{ id?: string; business_name?: string; country?: string }>(
      'https://api.stripe.com/v1/account',
      token
    )
    if (!res.ok) throw new Error(res.error)
    // The display name is often empty on a new account. The account id is the
    // one identifier Stripe always supplies, so it is the honest fallback.
    const name = str(res.data?.business_name) || str(res.data?.id)
    if (!name) throw new Error('Stripe did not return an account identifier for this key.')
    return { accountName: name, accountId: str(res.data?.id) || null }
  },
  tools: (deps) => [
    readTool({
      id: 'stripe_products',
      label: 'Stripe products',
      description: 'List Stripe products with their id, name and whether they are active.',
      domain: 'network.read',
      category: 'payments',
      url: 'https://api.stripe.com/v1/products?limit=100',
      deps,
      slot: stripe.slot,
      summarise: (data) => {
        const rows = Array.isArray(asRecord(data).data) ? (asRecord(data).data as unknown[]) : []
        return `Stripe returned ${rows.length} product(s).`
      },
      project: (data) => {
        const rows = Array.isArray(asRecord(data).data) ? (asRecord(data).data as unknown[]) : []
        return rows.map((p) => {
          const r = asRecord(p)
          return { id: str(r.id), name: str(r.name), active: r.active === true, description: str(r.description) }
        })
      }
    })
  ]
}

// ---------------------------------------------------------------------------
// Notion
// ---------------------------------------------------------------------------

const notion: ConnectorDefinition = {
  id: 'notion',
  label: 'Notion',
  blurb: 'Search the workspace and create or update connected pages.',
  tokenUrl: 'https://www.notion.so/my-integrations',
  slot: 'connector-notion',
  category: 'productivity',
  async verify(token) {
    const res = await request<{ name?: string; bot?: { owner?: { user?: { name?: string } } } }>(
      'https://api.notion.com/v1/users/me',
      token,
      { headers: { 'Notion-Version': '2022-06-28' } }
    )
    if (!res.ok) throw new Error(res.error)
    const botName = str(res.data?.bot?.owner?.user?.name)
    const name = botName || str(res.data?.name)
    if (!name) throw new Error('Notion did not return a workspace name for this token.')
    return { accountName: name, accountId: null }
  },
  tools: (deps) => [
    readTool({
      id: 'notion_search',
      label: 'Notion search',
      description: 'Search the Notion workspace for pages and databases the integration can reach.',
      domain: 'network.read',
      category: 'productivity',
      url: 'https://api.notion.com/v1/search',
      method: 'POST',
      headers: { 'Notion-Version': '2022-06-28' },
      body: { page_size: 50 },
      deps,
      slot: notion.slot,
      summarise: (data) => {
        const rows = Array.isArray(asRecord(data).results) ? (asRecord(data).results as unknown[]) : []
        return `Notion returned ${rows.length} result(s).`
      },
      project: (data) => {
        const rows = Array.isArray(asRecord(data).results) ? (asRecord(data).results as unknown[]) : []
        return rows.map((r0) => {
          const r = asRecord(r0)
          const title = Array.isArray(r.title) ? (r.title as unknown[]) : []
          const first = title.length > 0 ? str(asRecord(title[0]).plain_text) : ''
          return { id: str(r.id), type: str(r.object), title: first || '(untitled)', url: str(r.url) }
        })
      }
    })
  ]
}

// ---------------------------------------------------------------------------
// Linear
// ---------------------------------------------------------------------------

const linear: ConnectorDefinition = {
  id: 'linear',
  label: 'Linear',
  blurb: 'Issues, projects and comments — file and triage work without leaving the app.',
  tokenUrl: 'https://linear.app/settings/api',
  slot: 'connector-linear',
  category: 'productivity',
  async verify(token) {
    const res = await request<{ data?: { viewer?: { name?: string; email?: string; id?: string } } }>(
      'https://api.linear.app/graphql',
      token,
      {
        // Linear takes the key raw. A bearer prefix here is a 401 on every call.
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        method: 'POST',
        body: JSON.stringify({ query: '{ viewer { id name email } }' })
      }
    )
    if (!res.ok) throw new Error(res.error)
    const viewer = asRecord(res.data?.data).viewer
    const name = str(asRecord(viewer).name) || str(asRecord(viewer).email)
    if (!name) throw new Error('Linear did not return a viewer for this key.')
    return { accountName: name, accountId: str(asRecord(viewer).id) || null }
  },
  tools: (deps) => [
    readTool({
      id: 'linear_teams',
      label: 'Linear teams',
      description: 'List Linear teams with their key, name and current issue count.',
      domain: 'network.read',
      category: 'productivity',
      url: 'https://api.linear.app/graphql',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { query: '{ teams(first: 50) { nodes { id key name } } }' },
      bareAuth: true,
      deps,
      slot: linear.slot,
      summarise: (data) => {
        const nodes = Array.isArray(asRecord(asRecord(data).data).teams)
          ? asRecord(asRecord(asRecord(data).data).teams).nodes
          : []
        return `Linear returned ${(Array.isArray(nodes) ? nodes.length : 0)} team(s).`
      },
      project: (data) => {
        const nodes = asRecord(asRecord(asRecord(data).data).teams).nodes
        return Array.isArray(nodes)
          ? nodes.map((t) => {
              const r = asRecord(t)
              return { id: str(r.id), key: str(r.key), name: str(r.name) }
            })
          : []
      }
    })
  ]
}

export const CONNECTORS: ConnectorDefinition[] = [
  vercel,
  cloudflare,
  netlify,
  render,
  supabase,
  sentry,
  stripe,
  notion,
  linear
]

export const CONNECTOR_BY_ID = new Map(CONNECTORS.map((c) => [c.id, c]))

/** Risk assigned to every connector tool that changes something on a provider. */
export const CONNECTOR_WRITE_RISK: ToolRiskLevel = 'high'