/**
 * Redaction.
 *
 * Anything that can carry a secret into an audit record, a transcript, a
 * timeline entry, an approval prompt or a model request passes through here
 * first. The rule is deliberately blunt: it is better to redact a harmless
 * string than to leak a live credential into a log file the user never opens.
 *
 * Two independent layers, because either one alone has a hole:
 *
 *  - **Declared** — a tool names the argument keys that are sensitive
 *    (`apiKey`, `token`, …). Precise, and the only layer that understands
 *    structure.
 *  - **Heuristic** — anything that *looks* like a credential is scrubbed
 *    regardless of where it came from, including out of command output the
 *    agent never asked to be secret.
 */

const REDACTED = '[redacted]'

/** Argument names whose values are never recorded. */
const SENSITIVE_KEY = /(pass(word|phrase)?|secret|token|api[-_]?key|credential|auth|bearer|cookie|session[-_]?id|private[-_]?key|client[-_]?secret|access[-_]?key)/i

/**
 * Value shapes that are credentials wherever they appear.
 *
 * Each entry carries its own replacer rather than sharing one positional
 * callback: a shared replacer that guesses at capture-group positions is
 * exactly how a redaction ends up keeping the value it was meant to drop.
 */
const SECRET_VALUE_PATTERNS: { pattern: RegExp; replace: (match: string, ...groups: string[]) => string }[] = [
  {
    // PEM private key blocks, including the body.
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => REDACTED
  },
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, replace: () => REDACTED },
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replace: () => REDACTED },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replace: () => REDACTED },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: () => REDACTED },
  { pattern: /\bglpat-[A-Za-z0-9_-]{16,}\b/g, replace: () => REDACTED },
  { pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, replace: () => REDACTED },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: () => REDACTED },
  { pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g, replace: () => REDACTED },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replace: () => REDACTED },
  {
    // `Authorization: Bearer <token>`. Checked before the generic key=value
    // rule, otherwise that rule consumes the word "Bearer" as the value and
    // leaves the actual token behind.
    pattern: /(\b(?:Bearer|Basic|Token)\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
    replace: (_match, prefix: string) => `${prefix}${REDACTED}`
  },
  {
    // `api_key=value`, `password: "value"`, `"token" = value`. The credential
    // name is preserved so the log stays readable; the value never is.
    pattern:
      /(["']?\b(?:api[_-]?key|access[_-]?key|secret|password|passwd|token|auth(?:orization)?|credential)\b["']?\s*[:=]\s*)(["']?)([^\s"',;]{4,})/gi,
    replace: (_match, prefix: string, quote: string) => `${prefix}${quote}${REDACTED}${quote}`
  }
]

/** URLs carry credentials in the userinfo position. */
const SECRET_IN_URL = /(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s:@]+)@/gi

/**
 * Strip credential-shaped substrings from a single string.
 *
 * Exported for use on tool output and command stdout, which is where secrets
 * leak most often.
 */
export function redactText(text: string): string {
  let out = text
  for (const { pattern, replace } of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, (...args: unknown[]) => {
      const groups = args.slice(1, -2) as string[]
      return replace(args[0] as string, ...groups)
    })
  }
  out = out.replace(SECRET_IN_URL, (_m, scheme: string) => `${scheme}${REDACTED}@`)
  return out
}

/**
 * Redact a value for the audit trail.
 *
 * `sensitiveArgs` is authoritative: those keys are replaced wholesale. Anything
 * else is walked structurally and scrubbed heuristically, so a secret that the
 * tool never thought to mark is still not recorded.
 */
export function redactArgs(args: unknown, sensitiveArgs: readonly string[] = []): unknown {
  const declared = new Set(sensitiveArgs.map((s) => s.toLowerCase()))

  const walk = (value: unknown, depth: number): unknown => {
    if (depth > 8) return REDACTED
    if (typeof value === 'string') return redactText(value)
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1))

    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (declared.has(key.toLowerCase()) || SENSITIVE_KEY.test(key)) {
        out[key] = REDACTED
      } else {
        out[key] = walk(inner, depth + 1)
      }
    }
    return out
  }

  return walk(args, 0)
}

/** True when a key should be treated as sensitive even if not declared. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key)
}

/** Short, safe rendering of arguments for an approval prompt. */
export function summarizeArgs(args: unknown, sensitiveArgs: readonly string[] = []): string {
  let text: string
  try {
    text = JSON.stringify(redactArgs(args, sensitiveArgs)) ?? String(args)
  } catch {
    text = String(args)
  }
  return redactText(text.length > 600 ? `${text.slice(0, 600)}…` : text)
}

export { REDACTED }