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
- [x] **Space Bunny Alpha "Max" — probed, does not exist.** Both
      `stealth/space-bunny-alpha-max` and `space-bunny-alpha-max` return HTTP 400
      `is not a valid model ID`. Resolved: the app ships the model the provider
      actually serves. Recorded in `audit.md`, not papered over.
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
- [x] Verified: `CRYPTORIC_SHOT_TASK="hi"` → real DOM text `Hi! What can I help you with?`
- [x] Multi-turn conversation history is **stored** — PHASE 0.6
- [x] The **implement** stage is now model-driven with real tools; `analyze`/`verify`/`review`
      remain deterministic. The adaptive planner is still Phase 1.

## PHASE 0.6 — The agent actually acts, and remembers — DONE, VERIFIED

The complaint this answers: *"the chat history are not saving … it told it just did this
and stopped it not working, I sent a big prompt for making the website."*

### 0.6.1 Agent loop
- [x] `agent/loop.ts` — model requests a tool, the tool runs through `ToolRuntime`,
      the real result goes back, repeat until the model answers in prose
- [x] `ModelGateway` speaks tool-calling: `tools` + `tool_choice` on the wire,
      `toolCalls` and an `assistantMessage` to echo back so `tool` messages are not orphaned
- [x] A malformed `arguments` payload is answered with a tool error, not thrown and not
      dropped — an unanswered `tool_call_id` fails the next request
- [x] Bounded at 12 steps; running out says so instead of spinning
- [x] Provider failure ends the run and reports itself rather than retrying
- [x] Tools go through `AgentRuntime.invoke`, never `registry.get(id).execute()` — one
      enforcement path for policy, approval, timeout, cancellation, redaction and audit
- [x] Every tool result is persisted as a transcript turn, so the history is evidence
      rather than claims

### 0.6.2 The fabricated message
- [x] `implementStage` no longer prints "no language model is configured" unconditionally.
      It prints only when `gateway.isEnabled()` is false, which is the whole fix.
- [x] `pipeline.tools.call` stub (`error: 'not wired'`) deleted; the stage tool surface
      is wired to the registry
- [x] The redundant pre-stage `AgentRuntime.answer()` turn is removed — one model
      conversation per prompt, not two

### 0.6.3 Persistent conversation
- [x] `ConversationStore` — main-owned, atomic (temp + rename), bounded at 1000 turns,
      survives a corrupt file without refusing to boot
- [x] The user's own prompt is a turn, so the history reads as a conversation and the
      model has the request in context next turn
- [x] Tool outcomes fold into the assistant turn that reported them; the model never
      receives an orphan `tool` role message
- [x] Renderer loads history on boot and renders `You` / `Cryptoric Chan` / tool rows
      at three weights
- [x] Main-process `log` pushes no longer become chat messages
- [x] IPC `conversation:list` / `conversation:clear`, gated on `env.modify` for the clear
- [x] The clear route is reachable: "Clear history" in the chat pane, with a confirm,
      because an empty registration is worse than a missing one
- [x] `App.tsx` forwards `remember` / `toolId` — it was dropping them, which silently
      turned "Allow for this session" into "Approve once"

### 0.6.4 `run_command`
- [x] Built on the existing `exec.ts` — no second executor
- [x] cwd contained in the workspace; argv permission tier re-derived by
      `classifyCommand`, never taken from a caller label
- [x] Executable resolved on the managed PATH first, so "not installed" is a real
      `dependency-missing` rather than an opaque ENOENT
- [x] Windows batch files: cmd metacharacters in arguments are **refused**, not quoted
- [~] No live check of its own yet — registered, typechecked, argv refusal unit-tested

### 0.6.5 Bugs the live run found (none visible to unit tests)
- [x] Relative paths resolved against `process.cwd()` instead of the project root, so
      every `index.html` the model asked for was rejected
- [x] `write_file` hung the run instead of failing: an unanswered approval promise makes
      Node exit 13 with no error at all
- [x] "Allow for this session" granted nothing — the runtime only skipped the prompt for
      `safe` tools, so `write_file` re-prompted every single time
- [x] A session grant could override an explicitly configured `deny`
- [x] The review harness captured the agent mid-run (fixed 4 s wait)

### 0.6.6 Task titles
- [x] `deriveTitle()` replaces `prompt.slice(0, 60)` — strips fences, HTML, attribute
      soup, and separator runs (which is what put `id="qv7k3r" ============` in the list)

### 0.6.7 Verification
- [x] `npx vitest run` — **351 passed / 15 files**
- [x] `npm run test:browser` — 59/59 · `CRYPTORIC_BROWSER_TARGET=file` — 50/50
- [x] `npm run test:model` — 6/6 against the live provider
- [x] **`npm run test:agent`** (new) — 13/13: a real website prompt through the real
      model and real tools produces a real `index.html` on disk
- [x] Real Electron app — `CRYPTORIC_TASK_DONE {"status":"COMPLETED",
      "changedPaths":["…\\index.html"]}`, 711-byte file on disk
- [x] Relaunch with no new task — the whole prior conversation re-rendered from disk

### 0.6.8 Still open
- [x] Conversation is app-scoped, not project-scoped — **DONE**: `ConversationStore`
      v2 keeps a `scopes` map keyed by project root, `scopeKey()` lowercases for
      Windows, version-1 transcripts migrate into the `none` scope
- [x] `run_command` has no live check of its own — **DONE**: `npm run test:command`,
      **12/12** — real `node -e` stdout, real exit code + stderr, `npm --version`
      through `cmd.exe`, `rm -rf /` and `git push --force` refused with a sentinel
      file proving nothing ran, cancellation kills the child, 10 invocations audited
- [x] Coin allowance migration — **DONE**: `migrateAllowance` + `RETIRED_ALLOWANCES`,
      `SETTINGS_VERSION = 3`, `npm run test:migration` **3/3**
- [ ] The loop offers all ~55 tools instead of a routed subset (PHASE 12).
      `routeTools()` exists in `src/main/services/tools/router.ts` but is **not
      wired into `runAgentLoop`** (`LoopDeps.listTools` is the seam). Note its
      intent chains name tool ids that do not exist yet (`analyze_project`,
      `search_code`, `run_tests`, …). Open design question: the model must still
      be able to reach a tool the router dropped.
- [ ] No streaming; a long run shows nothing until the turn completes

## PHASE 0.7 — Hosted providers and application updates — DONE, VERIFIED

- [x] APINEX as a real provider kind: `APINEX_ENDPOINT`, `APINEX_CREDENTIAL`,
      `PROVIDER_CREDENTIAL_SLOTS`, own slot in `.env` seeding and Settings export
- [x] Key verification implemented — `GET /v1/models`, measured 200 vs 401
- [x] Five models shipped, each proven with a real completion **and** a real tool
      call: `free/gpt-6-luna`, `free/glm-5.3-flash`, `free/deepseek-v4.1-flash`,
      `free/deepseek-v4-pro-0813`, `free/mimo-v2.6-pro`
- [x] **Two ids in APINEX's own material do not exist and are recorded as such**:
      the Quick start snippet's `free/gpt-5.6-luna` (404) and the model card's
      truncated `free/deepseek-v4-pro` (404). The live check asserts they stay out.
- [x] Eleven other `free/`-prefixed ids answer HTTP 402 "subscription only" on a
      plain key — deliberately not shipped
- [x] OpenRouter free models: `poolside/laguna-s-2.1:free`, `inclusionai/ling-3.1-flash`
- [x] **Thirteen free OpenRouter models ship** (v0.1.3). Ten added this pass:
      `apodex-1.1-mini-free`, `ling-3.0-flash-sante-free`, `qwen3.8-27b-free`,
      `dots-3-note-preview-free`, `lfm-2.5-2.6b-free`, `nemotron-3.5-lightning-free`,
      `north-mini-code-free`, `nemotron-3-ultra-free`, `nemotron-3-super-free`,
      `nemotron-3-nano-omni-free`
- [x] **`poolside/laguna-xs-2.1:free` restored — it was rejected in error.** It is a
      *reasoning* model: at a 32-token budget it returns `content: ""` with
      `finish_reason: "length"`, which an earlier pass read as broken. Measured at the
      app's real 2048-token default: **3/3 answered**. Judged a model at the budget
      the app actually sends, not a smaller one.
- [x] **`fish-audio/s2.1-pro-free:free` rejected, with proof it works.** chat/completions
      returns HTTP 400 "is a text-to-speech model"; `POST /api/v1/audio/speech`
      returned HTTP 200, `audio/pcm`, 208,896 bytes. Real capability, wrong shape for a
      text agent — recorded, not shipped
- [x] `REJECTED_OPENROUTER_MODELS` holds 12 ids, each with a measured reason
- [x] **New invariant, unit-tested:** no id may appear both in `REJECTED_OPENROUTER_MODELS`
      and in `MODEL_CATALOG`, and every rejection must state a reason. This caught the
      real bug where Laguna XS was added to the catalogue while its old rejection entry
      was still present
- [x] `npm run test:agent:laguna-xs` — drives the agent loop with a reasoning model
- [x] **v0.1.3 built and published** — exe + `.blockmap` + `latest.yml`; published
      sha512 verified identical to the local build. `curl …/releases/latest/download/
      latest.yml` → `version: 0.1.3`. The ten new models now actually reach an
      installed app
- [x] Bounded retry with measured backoff (3s/10s/25s) for 429 and 5xx — the Ling
      model needs ~30s, a 1/2/4s ladder failed
- [x] Fixed a key leak: `resolveModel` preferred the configured credential slot, so
      picking an APINEX model while configured for OpenRouter would have sent the
      OpenRouter key to `apinex.bond`
- [x] Updates: `UpdateService` behind an `UpdatePort`, 12 unit tests
- [x] Checks on launch; downloads only when the user asks
- [x] A build that cannot check reports `unsupported` with the reason — never
      "up to date"
- [x] Settings → Updates, built from existing `SectionHead`/`card`/`row`/`Button`
- [x] `electron-builder.yml` publish target corrected to `Itz-Npg/Cryptoric-Agent`
- [x] Pushed to `origin/main`; release `v0.1.0` published with exe + `latest.yml` + `.blockmap`
- [x] Codebuff attribution stripped from all 15 prior commits; GitHub's contributor
      graph shows `Itz-Npg` only
- [ ] **A download and an install were never exercised** — the owner has now downloaded
      `v0.1.3` successfully, but the **install still has not been observed applying**.
      Root cause of the install failure found and fixed this pass (see PHASE 0.10):
      the approval gate never reached the renderer. `v0.1.4` is the first release that
      contains the fix, so it is the first version where the install path can run at
      all.
- [ ] **The Stop button and the update prompt have never been clicked by a human.** —
      **partly superseded**: the owner clicked Download and Restart & install, which is
      what exposed the approval-gate bug. The Stop button is still unclicked, and the
      scripted harness still cannot screenshot a running task.
- [ ] Binaries are unsigned; SmartScreen warns. Code signing not configured.

## PHASE 0.10 — Gated actions and the prompt composer *(done, verified)*

Two reports: *"restart now button not working"* and *"pasting a multi-line big prompt
lands on one line and tells me a character limit"*. Neither was the bug it looked like.

- [x] **Root cause of the dead Restart button found.** `IpcRouter.dispatch` created an
      `ApprovalRequest` for every gated channel but `RouterContext` had no `push`, so
      the prompt was never drawn, the waiter was never resolved, and the call died at
      the queue's **120 s timeout** returning `Not approved.` `UpdateService.install()`
      was never reached; `quitAndInstall()` never ran.
- [x] **Why Download worked and Restart did not** — `updates:download` is `network.read`
      → `safe` → allowed; `updates:install` is `env.modify` → `ask` → gated.
- [x] `RouterContext.push` added and called **before** the wait. Every gated channel
      fixed at once: `updates:install`, `env:install`, `terminal:list`, `process:list`,
      `process:restart`.
- [x] **Global approval overlay** — approvals were rendered only inside the Chan pane, so
      a prompt raised from Settings was invisible. `ApprovalPrompt.tsx` renders them over
      every pane, newest first, reusing the existing card. Owner-authorised UI exception.
- [x] Approval titles say what the action *is* ("replace the running app with the
      downloaded update"), not the channel id.
- [x] `tests/unit/ipc-router.test.ts` — **10 tests**: prompt pushed before waiting,
      denial reported, allowed domains never prompt, untrusted sender cannot provoke a
      prompt, large multi-line paste accepted. Reverting the push **fails 3 of them**.
- [x] **Paste root cause 1** — the composer was a single-line `<input>`, and Chromium
      strips newlines when pasting into one. Rebuilt as an auto-growing `<textarea>`
      (Enter sends, Shift+Enter breaks the line). Measured: **12/12 newlines preserved**,
      grew 46px → 266px, shrank back on submit.
- [x] **Paste root cause 2** — `agentSubmit` capped `prompt` at 20,000 chars, so a large
      paste was rejected at the IPC boundary with no prior warning. Now 200,000, read by
      both the schema and a live counter via `src/shared/limits.ts`.
- [x] **Renderer kept free of zod.** Importing the constant from `ipc-schemas` grew the
      renderer bundle to 463.24 kB; `limits.ts` (imports nothing) brought it to
      **346.78 kB**. `grep -l zod out/renderer/assets/*.js` prints nothing.
- [x] `npm run typecheck` exit 0 · `npx vitest run` **408 pass / 17 files** ·
      `npm run build:dir` exit 0
- [ ] **A release carrying these fixes has not been built yet.** The installed app still
      has the broken gate until then.
- [x] **"Version 0.1.3 is available. You are on 0.1.3." — a committed fix that was never
      shipped.** The remote tag `v0.1.3` resolves to `31de4ea`, two commits *before*
      `33be12e`. `electron-updater` populates `updateInfo` from the feed whether or not
      an update applies; on a current build it returns the running version with
      `isUpdateAvailable: false`, so reading `updateInfo.version` alone made an up-to-date
      build offer itself. Verified by reading the published source at that tag.
- [x] **Why it shipped untested:** the expression lived in `updater-electron.ts`, which
      imports `electron` and cannot be loaded by a unit test. `UpdateService`'s 15 tests
      use a fake port and never reached it — the one line deciding "is there an update"
      had zero coverage.
- [x] **Fixed structurally:** `translateFeedResult()` extracted to `updater-feed.ts`,
      which imports nothing; `updater-electron.ts` delegates so there is one copy of the
      rule. **8 new tests**, including the service reaching `not-available` rather than
      `available` for a current build. Reverting to the `v0.1.3` expression fails 2 of them.
- [x] **Second real bug found while widening the type:** the library declares
      `releaseNotes` as `string | ReleaseNoteInfo[] | object`, but the old code handled
      only the first and third. The array form — the one its own types list first — was
      silently dropped, so a per-release note list showed no notes. All three handled now,
      newest note taken from the array.
- [ ] **No follow-up composer once a transcript exists** (audit L13). `ChanPanel` renders
      `PromptComposer` only in the empty state; `ChanConversation` has no input. Found
      while fixing the paste bug, deliberately not fixed here.

## PHASE 0.9 — Real connectors *(foundation only, deliberately unsurfaced)*

- [x] `http.ts` — `request()`, `isAuthFailure` (400/401/403 — **Cloudflare returns
      400, not 401**, for a bad token), `extractErrorMessage`, `redact`
- [x] `definitions.ts` — 9 connectors, each `verify()` must return a provider-supplied
      account name. **Linear takes a bare API key, not `Bearer`.**
- [ ] Connector manager, credential slots, Settings → Connectors, tool registration, tests
- [ ] **No Connectors screen ships until all of the above exist.** An empty one reads as
      working. All 9 identity endpoints were probed live with invalid tokens: vercel 403,
      cloudflare 400, netlify/render/supabase/sentry/stripe/notion/linear 401

## PHASE 0.8 — Accounts / auth (owner-approved, not started)

- [ ] OAuth sign-in in the system browser, Authorization Code + PKCE. No password collection.
- [ ] Puter (`@heyputer/puter.js`) as a **user-pays** provider: `upstage/solar-mini4`
      costs $0.05/M in + $0.20/M out on OpenRouter and is $0 developer cost through
      Puter. Needs the sign-in flow above first — there is nothing real to wire it
      to until then. **Not faked.**

## PHASE 0.3 — Branding — DONE, VERIFIED

- [x] Packaged executable is `cryptoricagent.exe` (`executableName` in electron-builder)
- [x] `productName: CryptoricAgent`; window title, taskbar and Start menu follow
- [x] App logo replaced with the supplied artwork, rebuilt from source by
      `scripts/make-icon.py` so it is reproducible, not a checked-in blob
- [x] `build/icon.ico` carries 16/24/32/48/64/128/256, verified by parsing the container
- [x] userData carried across the rename so the credential store is not orphaned
- [x] `npm run dist` produces `cryptoricagent.exe` + `CryptoricAgent-0.1.0-x64.exe`
- [x] Icon verified **inside** the binary: `ExtractAssociatedIcon` matches the artwork
      exactly (mean difference 0.0), not just present in `build/`
- [x] Fixed a pre-existing config error that made `npm run dist` fail outright
      (`nsis.differentialPackageOptions`, removed from the electron-builder 25 schema)
- [ ] macOS `.icns` and Linux builds are configured but were never produced here
- [x] Elevation for packaging resolved — a **second** `npm run dist` at 23:07 succeeded with
      no elevation prompt, because the `winCodeSign` extract is cached. It is needed only on
      the first packaging run on a fresh machine.
- [ ] The binaries are unsigned: no certificate is configured, so SmartScreen will warn

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

- [x] `run_command` — **DONE in PHASE 0.6.4.** cwd, managed env, argv-derived tier,
      timeout, cancellation, bounded output, approval, audit. Windows batch
      metacharacters refused rather than quoted.
- [ ] `run_command` live check — drive it against a real project with a real subprocess
- [ ] Streaming command output into the terminal pane
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

## PHASE A — Multi-project workspace *(the open user complaint)*

The user can only work one project at a time; opening another swaps it. The persistence
half already exists (`ConversationStore` v2 scopes by project root). The parallel half
does not. This is the next thing to build.

- [ ] Project Registry with stable IDs (path is not identity) + ProjectDependencyGraph
- [ ] Project isolation: workspaceId / projectId / taskId on every scoped operation
- [ ] Project-aware everything: commands, processes, ports, terminals, git, environment,
      instructions, tests, readiness
- [ ] Project switching without restart; monorepo and independent-project support
- [ ] Cross-project tasks with dependency-ordered plans
- [ ] Project readiness **and** workspace readiness; a scoped release ignores unrelated failures

## PHASE B — Coin economy *(server-authoritative)*

- [ ] **FREE_DAILY_COINS = 25**, configurable server-side. Never 500.
      *(The client default is already 25; the server authority is not built.)*
- [ ] Existing installs still show `dailyAllowanceCoins: 500` in `settings.json`, because
      the persisted value wins over the new default. A one-time settings migration is
      needed so an upgraded install actually gets the new allowance.
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
## PHASE 0.11 — Coin balance truth and cross-platform packaging

- [x] **`0 / 500` root cause found; the recorded diagnosis was wrong.** `todo.md`
      claimed a settings migration was still needed. It was not — the migration ran
      and was already correct (`settings.json` on disk holds `dailyAllowanceCoins: 25`).
      `usage.dailyAllowanceCoins` was **read by nothing at runtime**; the gateway was
      fed `Math.round(state.dailyBudgetUsd * 100)` from the legacy flat state, which is
      still `5`, rendering 500 forever.
- [x] Gateway now reads `settings.get().usage.dailyAllowanceCoins`; `modelsSetBudget`
      writes back to settings instead of re-splitting the value across two stores.
- [x] **Second bug found while writing the test for the first:** `freshFromLegacy()`
      (no `settings.json` yet — the ordinary first launch after an upgrade) seeded
      500 and never ran `migrateAllowance`, since that only runs inside `migrate()`.
      The path that created the stale number never cleaned it up. The six existing
      tests missed it because they all write a `settings.json` first.
- [x] New end-to-end test: legacy flat state → `SettingsStore` → `ModelGateway.budget()`
      → **25**, with the old `*100` expression pinned at 500 so the trap is visible.
- [x] Verified against the owner's real files in a temp copy: old formula 500, new 25.
- [x] `FREE_DAILY_COINS = 25` confirmed as the schema default (`schema.ts`) and now the
      value actually in force.
- [x] `.github/workflows/release.yml` — `verify` → `build` (windows/macos/ubuntu matrix)
      → `release` (on `v*` tags). `npm ci`, `--publish never`, runner's own `gh` CLI.
- [x] Release job **fails if the tag disagrees with `package.json`** — otherwise
      `electron-builder` publishes 0.1.4 binaries under a v0.1.5 tag.
- [x] After publishing, re-downloads `latest.yml` and asserts it names the tagged
      version, because that file is what `electron-updater` actually reads.
- [x] `npm ci --dry-run` verified locally: exit 0, 652 packages from the lockfile.
- [x] **The workflow runs green** — run `37257563976`, `headSha 0f18eb9`, conclusion
      `success`. macOS and Linux are now **BUILT**, and the pre-existing local
      `cross-spawn ENOENT` does not occur on a real runner:
      - `CryptoricAgent-0.1.3.dmg` 109,305,858 B + `-arm64.dmg` 104,694,304 B
      - `CryptoricAgent-0.1.3.AppImage` 111,934,776 B
      - `cryptoric-agent_0.1.3_amd64.deb` 77,298,636 B
- [x] **"Keep it on release" resolved — artifacts expire, releases do not.** The
      build uploads *Actions artifacts* (temporary: `expires_at 2026-10-19`, never on
      the Releases page, not a shareable URL). The `release` job is the only bridge
      and is gated on `refs/tags/v*`, so **a green CI run publishes nothing at all.**
      The prior `v0.1.3` release had 3 Windows-only assets and no `latest-mac.yml`
      (`HTTP 404`), which is why macOS/Linux installed builds could not update at all.
- [x] **`v0.1.4` published** so the v0.1.3-shipping bugs reach installed builds: the
      dead Restart & install (approval gate never reached the renderer), the invisible
      global approval overlay, paste newlines dropped, and `0 / 500` instead of `0 / 25`.
- [ ] **A download and an install have still never been observed succeeding.** The
      root cause is fixed and unit-tested; `v0.1.4` is the first release that contains
      the fix, so this is the first version where the install path can actually run.
- [ ] Nothing is signed. macOS Gatekeeper will block an unquarantined `.dmg` until
      the user clears it; Windows SmartScreen warns. No certificates exist here.

## PHASE 0.12 — The agent execution hang *(done, verified)*

Reported: three stages green, header stuck on `Running — running`, nothing further,
indefinitely. Five independent defects; the first alone is sufficient to hang a
task forever. Full write-up in `audit.md`; the invariants in `work.md`.

- [x] **Root cause found.** `gateway.ts:713` read
      `signal: signal ?? AbortSignal.timeout(120_000)` — the deadline applied
      **only when no signal was passed**, and `runAgentLoop` always passes one. So
      on the path that mattered there was no deadline at all. Now composed with
      `AbortSignal.any`, and `attemptTimeoutMs` is injectable so the bound is
      testable in milliseconds instead of waited out in real time.
- [x] Backoff sleeps made abortable, so a stopped task no longer sits out the
      remaining 38s of the 3/10/25 ladder before unwinding.
- [x] **Model and tool watchdogs.** Every `complete()` and every `invoke()` is
      raced against a deadline; a miss emits `MODEL_TIMEOUT` / `TOOL_TIMEOUT` and
      reaches a terminal state.
- [x] **Stage watchdog** in `AgentRuntime.runStage`, because a stage can also hang
      on its own probe and nothing else bounded it.
- [x] **The UI was ticking stages at their start.** `runTask` emitted its only
      per-stage entry before `await stage.run()`, and `groupByStage` read "has an
      entry" as "finished" — so `Implemented changes` went green while the agent
      was still inside it. Now two markers (`-start`, `-end`/`-failed`) and
      completion keys off the second.
- [x] **Named execution states.** `ANALYZING / IMPLEMENTING / VERIFYING / FIXING /
      CANCELLING / BLOCKED` added to `TaskStatus`; `statusForRole` replaced by
      `statusForStage`. The two workspace-state derivations updated so the new
      states do not fall through to `IDLE`.
- [x] **Ceilings**, all configurable: 30 iterations, 40 model calls, 100 tool
      calls, 30 minutes. Reaching one stops and says *Agent execution limit
      reached* rather than continuing.
- [x] **`NO_PROGRESS_LOOP`** — compares rendered results, not tool names, so a
      genuinely changing result is not stopped.
- [x] **`verifyStage` actually verifies.** It ran `list_running_processes` and the
      UI called it *Ran tests and verified*. Now executes the project's own
      `typecheck` / `lint` / `test` / `build` and reports real exit codes;
      undeclared checks report SKIPPED, browser reports NOT RUN (no browser tools
      are registered), and a failing check fails the task.
- [x] **Per-call records** — requestId, provider, model, status, duration, token
      counts, finish reason. Usage renders as *Usage unavailable* when the provider
      returns none; never a fabricated zero.
- [x] **Failure classification** — RATE_LIMITED / AUTH_ERROR / NETWORK_ERROR /
      PROVIDER_ERROR / TIMEOUT / INVALID_RESPONSE / TOOL_ERROR / UNKNOWN.
- [x] **Heartbeat + structured log** — `[03:45:02] MODEL_COMPLETED mc_x model
      1240ms …`, `EXECUTION_FINISHED <state> reason=<…>`.
- [x] **Stop is real.** `CANCELLING` is a visible state before `CANCELLED`; the
      header and button reflect it, and the button disables so a second click
      cannot be read as a request that has not landed.
- [x] 39 regression tests in `tests/unit/agent-hang.test.ts` covering all ten
      required scenarios. The hang reproduction runs against a `fetch` mock that
      models undici — one that accepts the connection, goes silent, and rejects on
      abort — because a mock that simply never settles proves nothing.
- [x] `npm run typecheck` exit 0 · `npx vitest run` **453 passed / 18 files** ·
      `npm run build` exit 0. Hang reproduction: 180s of suite time → 312ms.
- [ ] **No live agent run has been driven through the new state machine against a
      real provider.** The fix is proven at the unit level and at the gateway
      boundary; end-to-end behaviour inside a real session is unverified.
- [ ] `maxAgentIterations`, `maxModelCalls`, `maxToolCalls` and `maxRuntimeMinutes`
      are not yet surfaced in Settings — they are constants a caller can override,
      not user-tunable.
- [ ] Browser tooling still does not exist, so the browser portion of the testing
      stage reports NOT RUN. That is honest, not implemented.

## PHASE 0.13 — The no-op / false-completion agent *(done, verified)*

*"Task complete — no files were changed."* with five green stages at `0 ms`.

- [x] **Root cause traced, not guessed.** `implementStage` returned
      `continue: true` when the model answered in prose (`used === 0`), and again
      when no provider was configured. `reviewStage` then returned `COMPLETED`
      because `changedPaths` was empty. Every stage ran; none checked the task.
- [x] **Intent classification** before execution — READ_ONLY / ANALYSIS_ONLY /
      IMPLEMENTATION / DEBUGGING / REFACTOR / TESTING / RESEARCH / CONFIGURATION /
      MIXED. Only the mutating ones require change.
- [x] **Real change detection by content hash**, before and after, replacing
      `changedPathOf`'s trust in `result.data.path`.
- [x] **`implementStage` blocks** when a mutating request produced no diff, naming
      which of six reasons applies (misunderstood / needs clarification / tools
      failed / read-only project / already present / nothing required).
- [x] **No model configured is BLOCKED**, not a green tick.
- [x] **`reviewStage` cannot report COMPLETED** without changed files behind an
      implementation request.
- [x] **Unbacked claims detected** — "I've implemented…" is a claim, not a result.
- [x] **`judgeFinalStatus`** — COMPLETED only with observed change or a
      correctly-diagnosed read-only request. Otherwise FAILED / BLOCKED / PARTIAL /
      CANCELLED.
- [x] **NOT_RUN instead of `0 ms`** for a phase that never executed.
- [x] **NO_TEST_SUITE_FOUND** reported when a project declares no known checks —
      explicitly not a pass.
- [x] **Execution evidence record** on the task: classification, file counts,
      created/modified/deleted, tool/model call counts, tests executed, final
      status. Surfaced as chips in the header. Visual language unchanged.
- [x] 42 regression tests covering all 18 required scenarios, including a real
      end-to-end run: real `write_file` through the real `ToolRuntime`, real
      approval gate answered by a stand-in human, real file on a real disk.
- [x] **Reverted, 4 tests fail.** Restored, 42 pass.
- [x] `npm run typecheck` exit 0 · `npx vitest run` **495 passed / 19 files** ·
      `npm run build` exit 0.
- [x] **Live provider run — DONE, 2026-10-05.** `tests/live/pipeline-check.ts`
      drives the real stages against the real key: **8 passed, 0 failed.**
      Run 1 (`"Create a file named landing.html containing a heading"`) — the
      model called `write_file` twice, the file exists on disk, and the log reads
      `[implement] 1 file(s) changed on disk: landing.html ok`, `COMPLETED, and
      backed by observed change`. Run 2 (`"What does index.js export?"`) —
      classified `READ_ONLY`, ran four real read tools, changed nothing, and
      finished `COMPLETED`, **not BLOCKED**. Both halves matter: an engine that
      demands edits from a question is as broken as one that accepts a no-op.
      `npm run test:agent` also passes 13/13 (real model, real `write_file`,
      `index.html` on disk at 2118 bytes).
      *The harness itself was wrong first time*: it registered only the
      filesystem tools and the pipeline died at `analyze` with "Unknown tool:
      inspect_environment". Only a live run surfaces that.
- [ ] The model must be observed genuinely refusing to call tools. If a provider
      returns prose for an implementation request, the engine now blocks — but
      retrying with a stricter tool prompt before blocking has not been tried.
- [ ] `run_command` exits are read from `data.exitCode`; a tool that returns
      neither an exit code nor a parseable summary counts as a pass. Tightened for
      the filesystem tools, not yet enforced across the whole registry.

### PHASE 0.13 addendum — structured tool results (§5)

- [x] **`NormalizedToolResult` now carries the structured effect**: `operation`,
      `filesChanged`, `filesCreated`, `filesDeleted`, `filesRenamed`, `timestamp`
      alongside the existing `durationMs`, `exitCode`, `artifacts`, `warnings`.
      Filled in by the runtime from what the tool reported.
- [x] **`changedPathOf` no longer uses a four-name allowlist.** It reads the
      structured `filesChanged`. `delete_file` and a move's source were
      previously invisible to the engine.
- [x] **A move is a rename**, not a create plus a delete — reporting it that way
      loses the fact that the file survived.
- [x] **`delete_file` now reports `deleted: true`**, which is what lets the
      runtime distinguish a delete from a read at all.
- [x] **Only a tool whose operation is `write` may report a change.** Found by a
      test: `read_file` returns a `path` like every other tool, and the first
      version of this classified that as a modification — a pure read reporting
      `filesChanged: [...]`. That is the same false-positive class the whole
      phase exists to eliminate, introduced by the fix for it. Caught before
      commit, fixed at the cause rather than by relaxing the assertion.
- [x] 5 new tests asserting created vs modified vs deleted vs read through the
      real runtime. **500 tests / 19 files**, typecheck 0, build 0.
