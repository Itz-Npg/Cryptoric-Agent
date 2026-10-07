# Security review

This document is the security posture of the Electron app's main process. It is
cited from `src/main/index.ts` and `src/main/ipc/router.ts`, which is why it
exists as a file rather than comments: a threat model that lives only in prose
next to the code drifts away from the code, and a reviewer cannot check a claim
against a diff.

**Scope.** The desktop app (Electron main + preload + renderer), the CLI, and
the tool runtime they share. The hosted account server, the mobile relay, and
the signing pipeline have their own documents.

**Stance.** Fail closed. An unrecognised command is `ask`, never `allow`; a
path that escapes its root is `deny`, never `ask`; an unverifiable path is
`deny`. Tool arguments are data, never policy: the runtime re-derives risk from
the actual argv and the declared tool tier, never from a caller-supplied label.

## Threat model

What this app defends against, in the order `src/main/services/permissions/policy.ts`
names them:

1. **Prompt injection** — content read from a repository, a web page, or a
   command can contain instructions aimed at the model. Defence is layered:
   the system prompt (`src/main/services/agent/prompts.ts`) tells the model to
   treat all tool output as data; the permission engine never consults the
   model for authority (tiers are re-derived from argv and tool descriptors);
   approvals require a human dialog the model cannot answer.
2. **Destructive action** — deletion, force-push, registry and disk writes are
   classified by parsing argv against explicit patterns; unclassifiable input
   defaults to the *higher* risk tier.
3. **Path traversal and symlink escape** — every filesystem path is resolved
   lexically and then re-checked on its *real* path (symlinks followed) before
   any read or write; see "Path containment" below.
4. **Renderer compromise** — a hijacked renderer must not reach the agent's
   tools, the filesystem, or the OS; see "Renderer containment".
5. **Secret leakage** — credentials at rest are encrypted with `safeStorage`;
   anything that can carry a secret into a log, transcript, approval prompt, or
   model request passes through the redactor first; see "Redaction".

## Renderer containment

- Window options: `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`, `webviewTag` off, no remote module. The CSP is set
  by the renderer document, not weakened from main.
- Navigation and window-open are denied outright
  (`will-navigate` → `preventDefault`, `setWindowOpenHandler` → `deny`); the
  renderer can never navigate away from the bundled app. `will-attach-webview`
  is denied.
- External URLs leave through `openExternalSafely()`, which parses the URL and
  allows only `https:`, `http:` and `mailto:`. `shell.openExternal` is a
  process launcher on Windows — `file:`, `ms-msdt:`, `search-ms:` and custom
  protocol handlers have all been used to turn "open this link" into code
  execution — so both call sites (OAuth start, window-open handler) go through
  the allowlist rather than calling `shell.openExternal` directly.

## IPC (`src/main/ipc/router.ts`)

Four gates run before any handler, in this order:

1. **Sender verification** — the event's `WebContents` must be the app's own
   top-level window. A frame from anywhere else is rejected and logged.
2. **Registration** — the channel must exist in the router; the renderer
   cannot invent one.
3. **Schema validation** — every payload is `safeParse`d against the channel's
   zod schema *before* dispatch, so handlers never see unvalidated data.
4. **Policy** — the channel's permission domain is evaluated; `deny` refuses,
   `ask` opens an approval dialog that is *pushed to the renderer before the
   handler waits on it* (a gate nobody can see is a hang, not a gate).

Errors are normalised: internal stacks are logged in the main process and
never returned to the renderer.

## Path containment (`checkPath` in `permissions/policy.ts`)

Every filesystem path — file tools, `FileService`, git operations, the
`run_command` working directory — funnels through `checkPath`:

1. Device/UNC prefixes (`\\?\`, `\\.\`) and null bytes are rejected outright.
2. The path is resolved against the **first workspace root** (never
   `process.cwd()`), then checked lexically against every root: `..`
   traversal, sibling-prefix tricks (`/work/repo-other` vs `/work/repo`), and
   absolute paths outside the roots are all denied.
3. The candidate **and each root** are then resolved to their real paths
   (symlinks followed, missing tails re-appended, dangling-symlink targets
   followed explicitly) and containment is re-checked. The kernel follows
   links, not text: a symlink inside the project pointing outside it passes
   the lexical check, so the lexical check alone is not a containment proof.
   A path that cannot be verified (`ELOOP`, `EACCES`, …) is denied —
   fail closed.
4. The **lexical** absolute is returned to callers, already collapsed, so it
   can never re-traverse a link on the way to the file.

Known limitation: this is check-then-use, not `O_NOFOLLOW`. An attacker who
can rewrite a symlink *between* the check and the open still wins that race.
Closing it requires opening the file and validating the descriptor, which
Node's `fs` cannot express portably; the residual window is microseconds and
requires an attacker who already writes inside the workspace.

## Permission tiers and session grants

Tiers: `safe` → `ask` → `elevated` → `destructive`. The runtime enforces, in
order: unknown tool → platform → dependencies → parse → **tier clamp** (a tool
can never exceed the caller's granted tier) → **policy** → **approval**
(timeout denies) → execute (bounded, cancellable) → output contract →
redact + audit.

Session grants ("Allow for this session") are:

- **domain-scoped** — one domain, not the whole app;
- **tier-capped** — the grant records the tier shown in the dialog the user
  approved; an `ask`-tier approval does not silently cover an `elevated` or
  `destructive` tool in the same domain (`hasSessionGrant(domain, tier)`);
- **time-bounded** — grants expire (`SESSION_GRANT_TTL_MS`, 4 hours) so an app
  left open over a weekend does not keep running on a Friday click;
- **never able to lift a `deny`** — a configured denial outranks a grant;
- **never persisted** — they live in a `Map` on the policy object and die with
  the process.

## Redaction (`tools/redact.ts`)

Two independent layers, applied to summaries, errors, warnings, **tool `data`
(file contents, command stdout, page text)**, audit records, approval details,
and anything entering a model request:

- **declared** — argument keys a tool marks sensitive are replaced wholesale;
- **heuristic** — credential-shaped values (PEM blocks, `sk-…`, `ghp_…`,
  `AKIA…`, JWTs, `Bearer …`, `key=value` secrets, userinfo in URLs) are
  scrubbed wherever they appear, including output the tool never expected to
  contain a secret.

A tool's `data` field is redacted before it enters the transcript or the next
model request: a secret printed by `cat .env` must not survive into the
conversation just because it arrived in the `data` slot.

## Inherited environment (`env/secrets.ts`)

Every child the agent spawns inherits an environment, and those children are the
processes it has *not* audited: a repository's `postinstall` hook, a build
script, a test runner. A developer who launched the app from a shell that also
holds `GITHUB_TOKEN` and `AWS_SECRET_ACCESS_KEY` was, until this existed, handing
both to every one of them — which turns "clone and install this repo" into an
exfiltration primitive with no exploit required.

The inherited (SYSTEM) layer is therefore filtered on business and on refresh:
credential-shaped variable names are withheld, logged by name, and absent from
the snapshot handed to a child. Two rules keep the filter honest:

- **Only the inherited layer is filtered.** A variable the user maps into the
  PROJECT or TASK layer is passed through untouched, because that is an explicit
  instruction from the person who owns the secret.
- **Over-matching is preferred to under-matching**, and `CRYPTORIC_PASS_ENV`
  names the individual variables to re-admit. Matching is case-insensitive
  everywhere, since `github_token` is read by real tools.

Names that point at a socket or a helper program (`SSH_AUTH_SOCK`,
`GIT_ASKPASS`) are explicitly exempt: they announce how to *ask* for a secret
and hold none themselves, so stripping them would break git-over-SSH while
protecting nothing.

This is a different leak from the one the redactor closes. The redactor scrubs
what a tool already read; this stops a credential reaching a process that could
exfiltrate it in the first place.

## Account server (`agentserver/`)

The hosted server is a separate threat surface with its own README, and two
rules are load-bearing:

- **A ban requires a credential that installs do not carry.** `POST /v1/integrity`
  deletes an account; the client token is identical in every installed copy of
  the app, so a shared secret that everyone holds authorises nobody. The route
  takes a separate operator token, and an admin token equal to the client token
  counts as unconfigured — two names for one secret is still one secret. A server
  that was never given one has the route switched off rather than open.
- **Every route but `/health` is rate limited**, by credential when the caller
  presents a known one and by remote address when it does not, which is what
  makes guessing a token slow without punishing normal traffic. `x-forwarded-for`
  is ignored: it is a header the caller writes, and a limit keyed by something
  the limited party chooses is not a limit. The limiter's own map is bounded, so
  a key an attacker influences cannot become a memory leak.

## Persistence and audit

- **Transcripts** (`agent/conversation.ts`) are written atomically
  (tmp + rename) with mode `0600` — they hold command output and file
  contents, which can include secrets the tools surfaced.
- **Session ledger** (`session/ledger.ts`) — `0600`, append-style rows; the
  balance is derived from rows, so tampering is visible in the sum.
- **Credential store** (`services/store.ts`) — `0600` and encrypted at rest
  with Electron `safeStorage`.
- **Audit trail** — every tool call is recorded in a bounded in-memory ring
  (500 records) *and* appended to `<userData>/audit.jsonl` via
  `services/tools/audit-sink.ts`: JSON Lines, append-only, rotated at 2 MB
  (one previous file kept), mode `0600`. The sink never throws — an audit
  disk failure must not fail the call it describes — and disables itself after
  a failure instead of logging on every call.

## Browser automation (`services/browser/`)

Per-tab sessions so cookies do not leak across sites; session state is wiped
when a tab closes; navigation denies dangerous schemes (`dom.ts`
`DENIED_SCHEMES`); the page bridge is the only path from page content to the
main process.

## Auth (`services/auth/google.ts`)

OAuth 2.0 with PKCE (`S256`), `state` compared in constant time, minimal
scopes (`openid email profile`), callback bound to loopback.

## Continuous checks

A defence that is only verified once is a defence that rots. Three workflows run
without anyone asking:

- **`.github/workflows/codeql.yml`** — CodeQL for `javascript-typescript` and
  `actions` on every push and pull request to `main`, plus a weekly sweep.
- **`.github/workflows/security.yml`** — `npm audit --omit=dev --audit-level=high`
  as a hard gate on shipped dependencies, a non-failing report of the build
  toolchain, and a CycloneDX SBOM built from the lockfile and kept as an
  artifact, so a released build can be matched against the components it came
  from months later.
- **`.github/dependabot.yml`** — weekly updates for the root npm manifest and
  the GitHub Actions, grouped so an Electron or toolchain bump arrives as one
  pull request. The `cli/` and `agentserver/` manifests are not covered: neither
  has a lockfile of its own, and `agentserver` has no dependencies at all by
  design.

The weekly triggers are the point: advisories are published on someone else's
schedule, so a repository with no commits this month still needs to hear that its
dependencies became a problem.

## Known gaps / not yet addressed

Honest list, so a reader of this document is not over-trusting it:

- **Electron 33.x is EOL** — Chromium 130 no longer receives security fixes.
  Upgrade is the single highest-value outstanding item.
- **No secret scanning on the repository.** GitHub's secret scanning and push
  protection are repository settings, not a workflow, and neither is enabled —
  it is a switch in Settings → Code security, not a file this repository can
  commit.
- **The dependency gate covers shipped dependencies only.** `npm audit` over the
  whole tree reports high and critical advisories in the build and test
  toolchain (`electron-builder` → `tar`, `vitest` → `tinypool`); those do not
  ship, and gating on them would fail every build until the tools are upgraded.
  `.github/workflows/security.yml` reports them on every run without failing it.
- **`npm run lint` does not pass** — roughly 1.5k pre-existing errors — so it is
  not a CI gate. A gate that is red on the first run is a gate people learn to
  ignore, which is worse than not having one.
- **Rate limiting is per-process and in memory.** Correct for one instance;
  behind N instances each keeps its own counters, so the effective limit is N
  times the configured one.
- **Approval prompts are domain-wide**: an approval for one tool in a domain
  (within the tier cap) covers other tools in that domain for the session.
- **The symlink check is check-then-use** (see Path containment).
- **The mobile relay** is its own surface: the protocol is a frame codec with no
  pairing or authentication concept yet.

## Verification

- Unit tests: `npm test` (permission policy incl. symlink containment and grant
  expiry/tier caps, tool runtime tier clamp + redaction + audit, IPC router
  gates, inherited-environment filtering, account-server authorisation and rate
  limiting).
- Live checks: `npm run test:agent`, `test:command`, `test:browser` — real
  Electron, real tools, real approval pump.
