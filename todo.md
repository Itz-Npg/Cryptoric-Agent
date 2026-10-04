# Cryptoric Agent — TODO

Ordered. One item at a time. Each phase ends with: typecheck → existing tests → new
tests → build → Git checkpoint. Never accumulate unverified changes.

Status: `[x]` done and verified · `[~]` in progress · `[ ]` not started

---

## PHASE 5 — Browser subsystem *(complete and verified)*

Infrastructure is done and verified. **All 43 tools are registered and exercised
against real Chromium.**

### 5.1 Browser core — DONE, VERIFIED
- [x] `BrowserTabManager` over `WebContentsView`, per-tab sessions in app cache dir
- [x] Isolated-world page bridge, CDP input, screenshot, accessibility tree
- [x] Console + network capture, storage reporting, navigation history
- [x] Background render host (real window, off-screen, no taskbar/focus)
- [x] 43 tools wired into the registry and the runtime
- [x] Live Electron check — **59 pass / 0 fail** (http target), **50 pass / 0 fail** (file target)
- [x] Pure-helper unit tests — 33 on the asset encoders

### 5.2 Browser tools — ALL 43 DONE, VERIFIED
- [x] navigation: `create_tab` `close_tab` `navigate` `back` `forward` `reload` `wait`
- [x] interaction: `click` `double_click` `hover` `type` `clear` `press_key`
      `select` `check` `uncheck` `scroll` `drag`
- [x] files: `upload_file` `download_file` `wait_for_download`
- [x] inspection: `get_url` `get_title` `get_text` `get_dom` `query_selector`
      `query_all` `get_attributes` `get_computed_style` `get_accessibility_tree`
- [x] capture: `screenshot` `console_logs` `network_requests` `network_failures`
- [x] session: `get_storage` `set_storage` `get_cookies` `clear_cookies`
- [x] dialogs: `handle_dialog` `handle_permission`
- [x] waits: `wait_for_navigation` `wait_for_element`
- [x] escape hatch: `evaluate_safe`

### 5.3 Test asset generation — DONE, VERIFIED
- [x] Local deterministic encoders: PNG, JPEG, WEBP, GIF, PDF, ZIP — real format bytes
      (magic, chunk CRCs, xref offset, LZW/zip records), not placeholder blobs
- [x] Assets live in `%TEMP%/CryptoricAgent/browser-tests/<taskId>/`, never in the repo
- [x] Executable extensions refused (`BLOCKED_EXTENSIONS`)
- [x] Cleanup after the task; leftover locks reported, never asserted away

### 5.4 Browser test safety — NOT STARTED
- [ ] Target classification: LOCAL / TEST / STAGING / PRODUCTION / UNKNOWN
- [ ] Production default read-only; destructive actions blocked
- [ ] Self-healing locator: stable id → role/name → label → text → CSS fallback;
      report ambiguity rather than clicking something else
- [ ] API/browser correlation: UI action → request → response → console → UI result

### 5.4 Browser test safety — NOT STARTED
- [ ] Target classification: LOCAL / TEST / STAGING / PRODUCTION / UNKNOWN
- [ ] Production default read-only; destructive actions blocked
- [ ] Upload safety gate: never allow executables as test assets
- [ ] Self-healing locator: stable id → role/name → label → text → CSS fallback;
      report ambiguity rather than clicking something else
- [ ] API/browser correlation: UI action → request → response → console → UI result

### 5.5 Advanced browser testing — NOT STARTED
- [ ] Form fuzzing with boundary values per discovered input
- [ ] Synthetic test data generator (reserved domains, no real personal data)
- [ ] Responsive: 375×812, 768×1024, 1280×720, 1440×900 — overflow, clipping, off-viewport
- [ ] Accessibility audit: names, labels, alt text, heading order, focus order, contrast
- [ ] Visual regression: screenshot baselines, pixel diff via `nativeImage.toBitmap`,
      classify EXPECTED / WARNING / BLOCKING
- [ ] Performance observation: navigation timing, resource timing, large assets —
      explicitly **not** Lighthouse

---

## PHASE 6 — Hosted model gateway *(done and verified)*

- [x] `openrouter` is a first-class provider: real endpoint, bearer auth, `X-Title`,
      optional `HTTP-Referer` only when the user configures one
- [x] **Space Bunny Alpha** wired to `stealth/space-bunny-alpha`, context 1,000,000,
      priced at the provider's declared `0 / 0`, with `pricingSource` + `pricingFetchedAt`
- [ ] ~~Space Bunny Alpha **Max~~~~ — probed, does not exist. Both
      `stealth/space-bunny-alpha-max` and `space-bunny-alpha-max` return HTTP 400
      `is not a valid model ID`. Recorded in `audit.md`, not papered over.
- [x] Selecting a catalogue entry that names a provider configures provider, endpoint
      and wire id — a picker row that does not change the request is worse than none
- [x] API key read once from gitignored `.env` → OS-encrypted credential store
      (`safeStorage`); never in source, never returned to the renderer
- [x] Real key verification: `GET /api/v1/key` reports tier and limit; a provider
      `label` shaped like a key is withheld from logs
- [x] BYOK rule: a user-supplied key does **not** draw the daily allowance
- [x] Daily allowance reduced **500 → 25 coins**; `lowBalanceWarningAt` 50 → 5
- [x] Live check against the real provider — 6 pass / 0 fail

## PHASE 0.5 — Small transient popup — DONE, VERIFIED

- [x] `Toast` primitive: `role="status"`, announces politely, self-dismisses after
      2 s, keeps the Dismiss button
- [x] The app's notice is a `Toast` — same position, same surface, same border
- [x] Verified end to end: a real "Re-read OS environment" click produced
      `CRYPTORIC_TOAST_SHOWN "Environment refreshed to snapshot 2…"` followed by
      `CRYPTORIC_TOAST_AFTER_TIMEOUT dismissed`
- [ ] Still undecided: which **destructive** action should raise a
      “Do you want to delete…?” popup. There is no delete flow in the app yet. The
      browser live-check fixture's `confirm()` is deliberately left alone — it is the
      only real subject for `browser_handle_dialog`, and removing it would delete the
      evidence that the dialog subsystem works.

## PHASE 0.4 — Chan has a voice — DONE, VERIFIED

- [x] `AgentRuntime.answer()` asks the configured model before any stage runs
- [x] Every failure reports words: no provider, provider error, cancellation
- [x] System prompt forbids claiming tool results the model cannot see
- [x] Boot adopts the hosted provider when the credential store holds its key
- [x] Submitting switches to the Chan pane, where the reply already was
- [x] Verified: `CRYPTORIC_SHOT_TASK="hi"` → real DOM text `Hi! How can I help?`
- [ ] Multi-turn conversation history is **not** stored — each task is stateless
- [ ] The five-stage pipeline is still fixed; the adaptive planner is Phase 1

---

## PHASE 1 — Capability detection

- [ ] Project Capability Detection Engine — type from evidence (manifest, lockfile,
      imports, entry points, Dockerfiles, CI), never from the project name
- [ ] Capability list: browser UI, desktop UI, CLI, HTTP API, WebSocket, database,
      auth, filesystem, uploads, downloads, payments, email, OAuth, storage, service
      workers, workers, env vars, secrets, migrations, publishing, installers, auto-update
- [ ] Test Applicability Engine — APPLICABLE / NOT_APPLICABLE / BLOCKED / OPTIONAL
- [ ] Test result states: NOT_RUN, RUNNING, PASSED, FAILED, BLOCKED, NOT_APPLICABLE,
      SKIPPED, WARNING
- [ ] Failure classification: PRODUCT_BUG, TEST_BUG, ENVIRONMENT_PROBLEM,
      DEPENDENCY_PROBLEM, CONFIGURATION_PROBLEM, NETWORK_PROBLEM, CREDENTIAL_PROBLEM,
      RESOURCE_PROBLEM, TOOL_FAILURE, UNKNOWN

## PHASE 2 — Real command and process execution

- [ ] `run_command` on the existing `exec.ts` — cwd, env, timeout, cancellation,
      streaming, redaction, approval, audit
- [ ] Process supervisor: start, background, stop, restart, list, monitor, logs,
      crash detection, readiness/health, project + task ownership, process trees,
      graceful-before-force termination
- [ ] Port manager: occupancy detection, owner detection, free-port selection,
      reservation, release, readiness, health checks, collision prevention

## PHASE 3 — Build, test, diff, git

- [ ] Build runner — detect npm/pnpm/yarn/bun/Vite/Next/Electron/TS/Python/Rust/Go/
      Java/Maven/Gradle/.NET/CMake/Make; use existing project scripts; structured errors
- [ ] Test runner — Vitest, Jest, Mocha, pytest, unittest, cargo, go, JUnit, Maven,
      Gradle, dotnet, CTest, custom. Prefer the project's own infrastructure
- [ ] Diff engine — changed files, line-level diff, summary, risk, affected tests
- [ ] Git integration — status, diff, log, branch, create, checkout, commit, restore,
      stash, merge on request, tag, conflict detection. Never destroy uncommitted work

## PHASE 4 — Code intelligence

- [ ] Symbol discovery, definitions, references, imports, dependency graph,
      structure, affected files, entry points, test files, config relationships
- [ ] Prefer existing language servers/parsers; no giant custom parser
- [ ] Lazy/targeted indexing for large repositories

## PHASE 7 — API, database, containers, network

- [ ] API testing — endpoint discovery, valid/invalid/missing/wrong-type/auth/status/
      schema/error, rate limiting only where safe. Never attack external APIs
- [ ] Database testing — type, ORM, migrations, schema; isolated resources only;
      never destructive against production
- [ ] Docker/Podman — detect, build, run, logs, health, networking, env, volumes,
      shutdown, cleanup; track every container created
- [ ] Network diagnostics — DNS, HTTP status, connectivity, TLS, port reachability,
      timing, proxy detection, failed-request diagnosis. No unauthorised scanning

## PHASE 8 — Security and dependencies

- [ ] Security scan — dependency vulns, exposed secrets, insecure config, unsafe
      headers, authn/authz issues, path traversal, command injection, unsafe subprocess,
      XSS/SQLi indicators, CORS, cookies, debug endpoints. Defensive only
- [ ] Dependency audit — outdated, vulnerable, conflicts, lockfile drift, duplicates,
      suspicious. Classify BLOCKING / WARNING / INFORMATIONAL
- [ ] MCP architecture — discovery, connection, schema validation, permissions,
      invocation, timeout, cancellation, audit, recovery

## PHASE 9 — TEST MODE and self-healing

- [ ] Isolated resources: temp files, temp databases, test users, test processes,
      test ports, test containers, test browser sessions, generated data
- [ ] Never: production databases, real user data, production credentials,
      destructive production actions, accidental external side effects
- [ ] Self-healing loop — capture, classify, reproduce, inspect logs/source/config,
      smallest safe fix, targeted retest, regression, bounded retries
- [ ] Regression test generation when practical

## PHASE 10 — PRODUCTION MODE

- [ ] Conservative preflight: build, env vars, config, no test config active,
      dependencies, versions, migration state, startup, health, expected ports
- [ ] Production smoke: homepage, login where safe, critical navigation, health
      endpoints, critical API, static assets; CLI `--version`/`--help`; desktop launch.
      Read-only only
- [ ] Environment classification LOCAL / TEST / STAGING / PRODUCTION / UNKNOWN;
      if UNKNOWN and the operation could be destructive → STOP

## PHASE 11 — Readiness and reporting

- [ ] Product Readiness state machine: PLANNING, BUILDING, RUNNING, TESTING, DEBUGGING,
      HARDENING, READY_FOR_REVIEW, PRODUCTION_VALIDATION, READY, READY_WITH_WARNINGS,
      BLOCKED, FAILED
- [ ] Release Readiness Engine → READY / READY_WITH_WARNINGS / BLOCKED / FAILED
- [ ] **Compilation alone must never mean READY**
- [ ] Strict readiness message derived from structured state, never natural-language guessing
- [ ] Final Validation Report — full structured report, becomes a task artifact

## PHASE 12 — Integration, scale, observability

- [ ] Router: contextual tool selection by task, capabilities, environment, permissions,
      applicable categories, availability. Never send every tool to every request
- [ ] Parallel execution with dependency-aware ordering and configurable resource limits
- [ ] Observability — task id, tool, timestamp, duration, redacted in/out, pid, errors,
      retries, state transitions, readiness transitions
- [ ] Resource cleanup — temp dirs, processes, ports, containers, browser sessions

## PHASE A — Multi-project workspace *(after the agent engine is healthy)*

- [ ] Project Registry with stable IDs (path is not identity) + ProjectDependencyGraph
- [ ] Project isolation: workspaceId / projectId / taskId on every scoped operation
- [ ] Project-aware everything: commands, processes, ports, terminals, git, environment,
      instructions, tests, readiness
- [ ] Project switching without restart; monorepo and independent-project support
- [ ] Cross-project tasks with dependency-ordered plans
- [ ] Project readiness **and** workspace readiness; a scoped release ignores unrelated failures

## PHASE B — Coin economy *(server-authoritative)*

- [ ] **FREE_DAILY_COINS = 35**, configurable server-side. Never 500.
- [ ] Immutable ledger: id, user, request, type, amount, before, after, model, reason, timestamp
- [ ] Atomic reserve → settle → refund. No negative balances, no race conditions
- [ ] Sources: FREE_DAILY, PAID_PLAN, BONUS, PROMOTIONAL, ADMIN_GRANT, REFUND, ADJUSTMENT
- [ ] Server-calculated pricing. Client never determines cost, plan, role or balance
- [ ] Low-balance protection and **cost-aware fallback** — never silently raise Cryptoric's bill
- [ ] BYOK and local models consume **no** Cryptoric coins. Local tools consume none.
- [ ] Coin UI shows real server data only, visual design unchanged

## PHASE C — Accounts, auth, security *(after A and B)*

- [ ] Roles FREE / PAID / ADMIN, server-side, granular admin permissions
- [ ] Google OAuth, Authorization Code + PKCE, system browser. No password collection
- [ ] Multi-tenant isolation; every query enforces ownership from the validated session
- [ ] Session security: access + refresh, rotation, logout, revoke, expiry, multi-device
- [ ] Account-scoped local data; logout clears account caches
- [ ] Encrypted local state; secrets in OS-backed secure storage; no secrets in source
- [ ] Admin bootstrap via deployment configuration (`ADMIN_BOOTSTRAP_EMAIL`,
      `ADMIN_BOOTSTRAP_SECRET`). One-time, rotated, invalidated after use. **Never invented here.**
- [ ] Security tests: role escalation, plan tampering, balance tampering, forged
      transactions, replay, negative spend, cross-user access, price tampering, expired
      and revoked sessions, admin endpoint access, IPC validation, path traversal