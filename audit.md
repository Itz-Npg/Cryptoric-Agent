# Cryptoric Agent — Verification Audit

Every claim below is backed by a command that was actually run. Anything not verified
is marked **NOT VERIFIED**. Nothing here is inferred from reading code.

Last audit: hosted model providers (APINEX + two verified-free OpenRouter models),
transient-failure retry, and GitHub Releases application updates — commit `6f7560f`
on `master`, pushed to `origin/main`.

---

## PASSING

| Check | Command | Result |
|---|---|---|
| Typecheck, main | `npx tsc -p tsconfig.node.json --noEmit` | exit 0 |
| Typecheck, web | `npx tsc -p tsconfig.web.json --noEmit` | exit 0 |
| Unit tests | `npx vitest run` | **351 passed / 15 files**, exit 0 |
| Production build | `npx electron-vite build` | exit 0 |
| Lint, whole repo | `npm run lint` | **exit 1 — ~350 pre-existing errors**, none in the files changed here |
| Browser, live, http target | `npm run test:browser` | **59 pass / 0 fail** |
| Browser, live, file target | `CRYPTORIC_BROWSER_TARGET=file npm run test:browser` | **50 pass / 0 fail** |
| Model gateway, live provider | `npm run test:model` | **6 pass / 0 fail** against `api.openrouter.ai` |
| **Agent loop, live provider + real filesystem** | `npm run test:agent` | **13 pass / 0 fail** — a real website prompt produced a real `index.html` on disk |
| **Agent loop, real Electron app** | `CRYPTORIC_SHOT_TASK="Build me a simple one-page website…" npx electron .` | task `COMPLETED`, `changedPaths` holds the real file, 711-byte `index.html` written |
| **Conversation survives restart** | relaunch with no new task | agent pane re-rendered the whole prior conversation from disk |
| **Session grant stops repeat prompts** | `CRYPTORIC_SHOT_APPROVE=1` + a two-file prompt | exactly **1** `CRYPTORIC_AUTOAPPROVE` for **2** `write_file` calls |
| **Denial is respected** | same run without auto-approval | `changedPaths: []`, no file written, denial reported |

## Providers, retry and updates — this pass

| Check | Command | Result |
|---|---|---|
| Unit tests | `npx vitest run` | **383 passed / 16 files**, exit 0 |
| APINEX, live provider | `npm run test:apinex` | **18 pass / 0 fail** against `api.apinex.bond` |
| APINEX key check, live | same run | `GET /v1/models` → 200 for a good key, 401 `"Invalid API key"` otherwise |
| **Agent loop on a free APINEX model** | `npm run test:agent:apinex` | **13 pass / 0 fail** — real `write_file` → real 401-byte `index.html`, `$${cost}` 0.000000 |
| **Agent loop on free OpenRouter models** | `npm run test:agent:laguna`, `npm run test:agent:ling` | **13/13** and **13/13** |
| OpenRouter free models, live | `npm run test:model` | **8 pass / 0 fail**; both free models answered at `usage.cost` 0 |
| APINEX models render in the real UI | `CRYPTORIC_SHOT=… npx electron .` | all five listed in Settings, frozen UI unchanged |
| Update policy | `npx vitest run tests/unit/updater.test.ts` | **12 pass / 0 fail** — no false all-clear, no unasked download |
| Packaged installer | `npx electron-builder --win nsis --publish never` | exit 0 → `.exe` 83,891,986 B + `latest.yml` + `.blockmap` |
| Feed config baked into the app | read `release/win-unpacked/resources/app-update.yml` | `owner: Itz-Npg`, `repo: Cryptoric-Agent`, `provider: github` |
| **Packaged app checks a real feed** | run `release/win-unpacked/cryptoricagent.exe` | before the release existed: `Error: No published versions on GitHub`, reported as an **error**, not "up to date" |
| After the release was published | same binary | logs `Checking for update` with **no error**; Settings shows `Checking for updates…` mid-flight |
| Feed endpoint electron-updater calls | `gh api repos/Itz-Npg/Cryptoric-Agent/releases/latest` | `v0.1.0`, assets: exe, `.blockmap`, `latest.yml` |
| Download URL the updater uses | `curl …/releases/latest/download/latest.yml` | version/sha512/size all resolve |
| No secret in any committed file | key-pattern scan over every staged file | clean; `.env` untracked and ignored |
| Contributor attribution | `gh api …/contributors` | **`Itz-Npg` only** — no Codebuff co-author in any ref |

### NOT VERIFIED

- **The final `0.1.0 is the latest version.` string was never captured on screen.**
  The review hook quits before the asynchronous check resolves; both packaged runs
  caught `checking`. The transition itself is covered by unit test; the rendered
  terminal line is not.
- **A download and an install were never exercised.** That needs a real `v0.1.1`
  newer than the running build. The download/install path is unit-tested against a
  fake port only.
- **macOS** — `.icns`/dmg cannot be produced on this Windows host. NOT BUILT.
- **Linux** — `npx electron-builder --linux` still fails on this host
  (`cross-spawn ENOENT`); undiagnosed. NOT BUILT.
- **Code signing** — binaries unsigned, so SmartScreen warns and NSIS installs are
  not verified by a signature.

### The complaint that started this pass

> *"the chat history are not saving when i give it prompt it told it just did this and
> stopped it not working i sent a big prompt for making the website"*

The screenshot showed five stage names scrolling past and the line
`No file edits were made: no language model is configured for this session` —
while `%APPDATA%\CryptoricAgent\credentials.json` held a valid OpenRouter key and
`state.json` said `modelProvider: "openrouter"`. Five distinct causes, all confirmed
against the running app:

| # | Cause | Evidence | Fix |
|---|---|---|---|
| 1 | `implementStage` printed "no language model is configured" **unconditionally** — a hardcoded string with no relation to gateway state. | [stages.ts](src/main/services/agent/stages.ts) line 166, read directly | Replaced with the real agent loop; the no-provider message now only prints when `gateway.isEnabled()` is false |
| 2 | The model was never asked to act. `pipeline.tools.call` was a stub returning `{ ok: false, summary: 'unavailable', error: 'not wired' }`. | [index.ts](src/main/index.ts), read directly | New `agent/loop.ts`; the stub is gone and the stage tool surface is wired to the registry |
| 3 | The transcript was renderer-only state. Restarting lost it and the model had no memory. | [useAppState.ts](src/renderer/src/state/useAppState.ts), `transcript` with no backing store | New main-owned `ConversationStore`, written atomically to `userData/conversation.json` |
| 4 | Main-process `log` pushes were rendered as chat messages, so the transcript filled with machine chatter instead of conversation. | Renderer `case 'log'` dispatching `say` | Removed; the transcript is now built only from `conversation` events |
| 5 | The task title was `prompt.slice(0, 60)`, which is why the list showed `id="qv7k3r" ================…`. | [index.ts](src/main/index.ts) `agentSubmit` handler | `deriveTitle()` strips fences, HTML, attribute soup and separator runs |

### What the live agent check actually proves

`npm run test:agent` drives the **same `runAgentLoop`**, the **same `ModelGateway`** and
the **same `write_file` from the real registry**, through the **same `ToolRuntime`**, over
real HTTPS against the real provider, into a temp directory. No mocked model — a run in
which the model does not call a tool is reported as a failure.

```
Steps: 3  tool calls: 3  -> list_directory, file_exists, write_file
[PASS] The model called a tool: list_directory, file_exists, write_file
[PASS] index.html exists on disk after the run
[PASS] index.html is 3677 bytes
[PASS] index.html contains a <title> / <h1> / <p>
[PASS] No extra files were created beyond what was asked for
[PASS] Conversation survived a reload (2 turns)
[PASS] Model context contains no orphan tool messages
[PASS] Pasted-prompt title is clean: "Build me a portfolio website"
--- 13 passed, 0 failed ---
```

And in the **real Electron app**, against a real empty project directory:

```
CRYPTORIC_AUTOAPPROVE write_file
CRYPTORIC_TASK_DONE {"status":"COMPLETED",
  "changedPaths":["…\\site-demo\\index.html"],"error":null}
```

`index.html` was 711 bytes on disk with a `<title>`, an `<h1>`, a `<p>` and an embedded
stylesheet. The agent pane showed `You` → `Cryptoric Chan` → tool results → final answer.

### Bugs the live run found that no unit test could have

These were found by **running the agent against a real model**, not by reading code.

1. **Every relative path was rejected.** `checkPath` called `resolve(candidate)`, which
   anchors to `process.cwd()` — the app's install directory, not the open project. The
   model asked for `index.html` and `.`; both came back `Path escapes the allowed
   workspace roots`. Fixed by resolving relative paths against the first workspace
   root. Without this the agent could not have created a single file, ever.

2. **`write_file` hung the run instead of failing.** With no human to click, the approval
   promise never settled and Node exited **13** on an unsettled top-level await — no
   error, no stack trace. That is what made the first live run look like a mystery.

3. **"Allow for this session" granted nothing.** The button called
   `policy.grantSession(domain, 'allow')`, but the runtime only skipped the prompt when
   `declaredTier === 'safe'`. `write_file` declares `ask`, so an agent writing eight files
   prompted eight times — exactly the behaviour the button was added to remove.

4. **A session grant could override an explicit `deny`.** `PermissionPolicy.decide()`
   consulted session grants *before* the configured rules, so one button press lifted a
   denial the user had set. Now a configured `deny` is absolute and outranks any grant.

5. **The review harness captured the agent mid-run.** `CRYPTORIC_SHOT_TASK` waited a
   fixed 4 s, so the screenshots showed empty stages. It now polls for a terminal task
   state. The half-finished picture is what made the agent look broken when it was merely
   early.

6. **`App.tsx` dropped the approval arguments.** `onResolveApproval={(id, approved) => …}`
   discarded `remember` and `toolId`, so "Allow for this session" was visually present
   and behaved exactly like "Approve once". Found by checking that every new control was
   actually reachable, not by reading the button.

7. **`clearConversation` was an unreachable capability.** The action, the IPC route and
   the preload method all existed; nothing in the UI called them. An empty registration is
   worse than a missing one, so the pane now has a "Clear history" control.

### Verification of the approval model in the real app

A two-file prompt (`index.html` + `style.css`) with auto-approval raised **exactly one**
approval, not two — proving the session grant persists across tool calls rather than
re-prompting per file. A run **without** auto-approval wrote nothing and ended with
`changedPaths: []`: the denial was reported, not worked around.

### What the live model check actually proves

The check drives the **same `ModelGateway` class** the application uses, over real HTTPS,
with a real key. No stubbed fetch, no canned response, no "connection successful" banner.

- the catalogue entry resolves to `stealth/space-bunny-alpha` via provider `openrouter`
- `GET /api/v1/key` — the provider **accepts** the stored key and reports its tier and limit
- `GET /api/v1/models` — the provider really lists that model (among 466)
- `POST /api/v1/chat/completions` — a real completion returned `"pong"` from
  `stealth/space-bunny-alpha`
- token usage came back from the provider (163 in / 2 out), not synthesised locally
- with a user-supplied key installed the gateway reports `metered: false` and draws
  **0 of 25 coins**

### Branding: `cryptoricagent.exe` and the supplied logo

| Check | Command | Result |
|---|---|---|
| Icon source cropped to the opaque tile | `python scripts/make-icon.py` | 1536x1024 master → 740x740 tile, shadow removed |
| `.ico` container well-formed | header + per-entry parse | type=1, 7 entries, all PNG payloads, 32 bpp |
| Sizes Windows will read | entry widths | 16, 24, 32, 48, 64, 128, 256 |
| Every icon file loads in Electron | `nativeImage.createFromPath` | `cryptoric-icon.png` 1024x1024 `isEmpty=false`; `icon.ico` 256x256 `isEmpty=false` |
| App name after rename | `app.getName()` | `"CryptoricAgent"` |
| userData after rename | `app.getPath('userData')` | `%APPDATA%\CryptoricAgent` |

### Packaging — verified against a real build, not the config

| Check | Result |
|---|---|
| `release/win-unpacked/cryptoricagent.exe` | exists, 188,869,120 bytes |
| Installer | `release/CryptoricAgent-0.1.0-x64.exe`, 83,880,050 bytes |
| Embedded icon is *your* artwork | `ExtractAssociatedIcon` vs `build/32x32.png` | **mean abs difference 0.0** — pixel identical |
| Version resource | `ProductName=CryptoricAgent`, `CompanyName=Cryptoric` |
| Packaged app window title | launched `cryptoricagent.exe`, read `MainWindowTitle` | `CryptoricAgent` |
| Packaged app runs | process check after launch | PID live, window present, credential store read from the migrated userData |

### Bug the packaged build exposed: a dead `title` option

The packaged exe launched with a title bar reading **"Cryptoric Agent"** even
though `BrowserWindow`'s `title` had been changed. The document title in
`src/renderer/index.html` overrides the window option the instant the page loads,
so the option was dead code — green typecheck, green build, wrong title.

Only launching the real artifact surfaced it. Both are now set, with a comment at
the `title:` site explaining why they have to agree.

Two pre-existing blockers were found by actually building, both invisible to typecheck,
unit tests and `electron-vite build`:

1. **`npm run dist` had never worked.** `nsis.differentialPackageOptions` was removed
   from the electron-builder 25 schema, so the whole config failed validation before a
   single file was written. Removed; `differentialPackage: true` is the live option.
2. **The icon step needs elevation on Windows.** electron-builder extracts
   `winCodeSign.7z`, which contains symlinks. Without
   `SeCreateSymbolicLinkPrivilege` the extract fails and the build dies *before*
   `rcedit`, leaving `cryptoricagent.exe` carrying Electron's stock logo and
   `ProductName=Electron`. Confirmed by extracting the icon from that intermediate
   binary and diffing it against the artwork (mean difference 48.5, centre pixel
   light blue — Electron's logo). Re-run once with approval and the same extraction
   returns a mean difference of 0.0.

The elevation is only needed on the first packaging run on a machine; the extracted
cache is reused afterwards.

### Bug the rename caused, and fixed

Renaming the app to `CryptoricAgent` silently orphaned the credential store.

The cause was an ordering mistake of mine. Electron fixes `userData` the first
time it is read and derives it from the app name **at that moment**. My first
version read the old path *before* `setName`, which pinned userData to the
pre-rename folder and made the rename a no-op — the app then ran against an empty
`%APPDATA%/cryptoric-agent`, found no key, and answered every prompt with
`Model endpoint returned 401`. The mistake was invisible in typecheck, build and
all 305 unit tests.

Fixed by setting the name first and deriving the legacy folder from `appData`,
which is a fixed path. The "already migrated" test is now whether **this app's own
files** (`state.json` / `settings.json` / `credentials.json`) exist in the target,
not whether the folder is non-empty — Electron populates a fresh userData with
`Cache`, `GPUCache` and `Preferences` on its own, so emptiness is never a signal.

Verified on a real launch: `Cryptoric Agent` absent, `CryptoricAgent` holds all
three data files, and Chan answered `Hi! What can I help you with?` — proving the
encrypted credential store survived the move.

The stray `%APPDATA%/cryptoric-agent` created by the bug was moved to
`cryptoric-agent-orphaned-by-rename-bug`, not deleted.

### Bug found and fixed: "hi" got no reply

Sending a prompt produced **silence**. The agent ran its fixed five-stage pipeline,
and the model gateway was never connected to it — `pipeline.tools.call` was a stub
returning `{ ok: false, summary: 'unavailable' }`. With no project open the first
stage returned `FAILED: 'No project is open.'`, so the transcript got one line and
no answer.

Fixed, and verified against a real window:

- `AgentRuntime.answer()` runs before any stage. It asks the configured model and
  puts the reply in the transcript. No model configured, provider refusing, or the
  task cancelled — all three report words back instead of silence.
- `chanSystemPrompt()` forbids claiming to have run tools, edited files or checked
  results. The pipeline reports what actually happened; the model is not allowed to
  narrate it.
- Boot adopts the hosted provider when the credential store already holds its key,
  so a working key next to a `none` default no longer means an assistant that says
  nothing.
- Submitting from Home switches to the Chan pane. The reply was always landing in the
  transcript; the view just never moved.

**"Space Bunny Alpha Max" does not exist** — see below.

### Model id finding — recorded, not papered over

The request was for **“Space Bunny Alpha Max”**. That model id does not exist.

| Probe | Command | Result |
|---|---|---|
| Catalog search | `GET /api/v1/models` filtered for `bunny` | 1 hit: `stealth/space-bunny-alpha` |
| `stealth/space-bunny-alpha-max` | `POST /api/v1/chat/completions` | **HTTP 400** `is not a valid model ID` |
| `space-bunny-alpha-max` | `POST /api/v1/chat/completions` | **HTTP 400** `is not a valid model ID` |
| `stealth/space-bunny-alpha` | `POST /api/v1/chat/completions` | **HTTP 200**, `"pong"` |

So the app ships the model the provider actually serves. A “Max” row that 400s on
first use would have been a fake capability, and this project does not ship those.
OpenRouter prices it `prompt "0"` / `completion "0"`, which is a declared zero
rather than an unknown — recorded as such in `pricingSource` / `pricingFetchedAt`.

### Where the API key lives

- `.env` (gitignored, `.env.example` committed with no values) is read **once** at boot
  by `src/main/services/models/dotenv.ts`
- the value is written into the credential store encrypted by `safeStorage`; the gateway
  reads it from there and nowhere else
- `.env` is never written back to, and a key already in the store always wins
- the provider's `label` field is dropped when it is shaped like a key — OpenRouter
  returns a masked form of the key there, so it is not surfaced to any log

| Secret-handling check | Result |
|---|---|
| `git check-ignore .env` | ignored |
| key present in any tracked file | no |
| key returned to the renderer by any IPC route | no |

### What the live browser check actually proves

Driving the **same** tool definitions the agent uses, through the **same** `ToolRuntime`,
inside a **real Electron process**, against a **real local HTTP server**:

- `browser_create_tab` normalises a bare `127.0.0.1:PORT` to `http://…` and loads it
- `browser_get_title`, `browser_get_text` read the real rendered document
- `browser_console_logs` captures the page's own `console.error`
- `browser_network_requests` reports a genuine 404 the console never showed
- `browser_network_failures` reports failed subresources
- `browser_query_selector` enumerates real form controls (`email:email`, `password:password`, `avatar:file`)
- `browser_get_dom` returns the form markup
- `browser_evaluate_safe` summary probe reads counts and viewport
- `browser_click` produces **real pointer events the page handled** — the counter went 0 → 2
- `browser_type` produced exactly `aarav@example.test`; the tool **reads the value back and
  fails if it does not match**, so this cannot pass vacuously
- `browser_select` committed an option and fired `change`
- `browser_wait` blocked until late-arriving content appeared
- `browser_screenshot` wrote a 27 KB real PNG (magic bytes checked) to the app cache dir,
  outside the repository
- `browser_get_accessibility_tree` returns real roles and names (`Add`, `Avatar`, `Create account`)
- `browser_reload` reused the same tab rather than opening another
- a real link click navigated, and `browser_back` returned
- the tab exposes a real per-tab session storage path
- the tab drives real Chromium with a non-zero laid-out viewport
- closing a temporary tab really closed it
- all 26 calls were audited by the runtime

### Bugs the live check found that unit tests could not

1. Detached view had no viewport → nothing was visible → nothing could be clicked.
2. `debugger.attach` after first navigation → input silently routed to the previous
   document; `elementFromPoint` agreed with the coordinates, dispatch succeeded, nothing happened.
3. Chord keys carried `text` → `Ctrl+A` typed a literal `A`.
4. `show:false` and `offscreen:true` windows both produce empty screenshots.

### Bugs the unit tests found in my own code

5. `LETTER_CODES = 'KeyABC…'.split('')` produced characters, not `'KeyA'`-style codes —
   every letter and punctuation key reported `code: ''`.
6. `normalizeUrl('settings', base)` resolved to `http://settings/` instead of against the base.
7. `@` had no `code` mapping, so an email address lost its shift-layer identity.

---

## KNOWN LIMITATIONS (honest)

| # | Limitation | Evidence | Severity |
|---|---|---|---|
| L1 | This machine's Chromium does not deliver synthesized input to **network-origin** renderers. | Reproduced with a bare `WebContentsView` + raw `debugger.sendCommand`, zero Cryptoric code. Same code works on `file:` and `data:` origins. | Environment, not product. Interaction checks run against the `file:` copy of the same page. |
| L2 | A temporary profile directory can survive tab close on Windows. | Async cleanup with 12 retries still hits `EPERM`. | Cosmetic. Tab is verifiably closed; the leftover is reported, never asserted away. |
| L3 | No performance benchmark exists. | Never run. | Tool timeouts are reasoned bounds, not measured. |
| L4 | Settings persist and validate but most values are not yet consumed by engine consumers. | By inspection. | Real gap. |
| L5 | Router exists and is tested but the pipeline still runs a fixed stage list around the model. | By inspection. The **implement** stage is now model-driven with real tools; `analyze`/`verify`/`review` remain deterministic. | Real gap, much reduced. |
| L6 | Conversation is project-scoped, but the app still runs **one project at a time**. | `ConversationStore` v2 keeps a `scopes` map keyed by project root; opening a second project swaps the workspace rather than running both. | Real gap — the persistence half of PHASE A exists; the parallel half does not. |
| L7 | The agent loop offers the model every registered tool (~55) rather than a routed subset. | By inspection. | PHASE 12 router. The context window is 1M so this is a precision problem, not a capacity one. |
| L8 | `run_command` live check. | **DONE** — `npm run test:command`, **12/12**: real `node -e` stdout, real exit code and stderr, `npm --version` through `cmd.exe`, `rm -rf /` and `git push --force` refused with a sentinel file proving nothing ran, cancellation kills the child, 10 invocations audited. | Closed. |
| L9 | **A downloaded update was never installed.** | `UpdateService` is 12 unit-tested against a fake port. `v0.1.1` and `v0.1.2` are a real pair, so the owner can exercise this himself; no scripted run has observed a download complete and an install apply. | Unverified by machine. |
| L10 | The **Stop** button and the update prompt have never been clicked by a human. | Wired, typechecked, unit-tested. The scripted harness stops the task before it can screenshot the running state, so live capture is impossible with the current hook. | Unverified by machine. |
| L11 | OpenRouter free models share a **50-request/day per-account cap**, separate from `GET /api/v1/key`. | Exhausted by live probing on 2026-10-05; `/chat/completions` returned HTTP 429 `free-models-per-day` while `/api/v1/key` still reported 100/100. | Environment, not product. Makes a live provider run **BLOCKED**, never `FAILED`. |
| L12 | The agent loop offers the model every registered tool. | `routeTools()` exists in `src/main/services/tools/router.ts` but is **not wired into `runAgentLoop`** (`LoopDeps.listTools` is the seam). Its intent chains name tool ids that do not exist yet (`analyze_project`, `search_code`, `run_tests`). | PHASE 12 router. |

---

## NOT IMPLEMENTED (stated plainly, never dressed up)

- `run_command` — **DONE.** Built on the existing `exec.ts`; cwd containment, managed-env
  resolution, argv-derived permission tier, timeout, cancellation, bounded output.
  On Windows a `.cmd`/`.bat` is exec'd through `cmd.exe`, and arguments containing
  `& | < > ^ % ! "` are **refused** rather than quoted — quoting is not sufficient
  because cmd expands those inside double quotes too.
- Build runner, test runner, diff engine, Git toolset
- Code intelligence / symbol index
- Project capability detection, test applicability engine
- Process start, port manager, resource limits
- Visual regression, responsive testing, accessibility audit, performance observation
- API testing, database testing, Docker, network diagnostics
- Security scanning, dependency auditing
- MCP / connectors — **foundation only, deliberately not surfaced.**
  `src/main/services/connectors/{http.ts,definitions.ts}` define 9 real connectors
  (vercel, cloudflare, netlify, render, supabase, sentry, stripe, notion, linear),
  each with a `verify()` that must return a provider-supplied account name. There is
  **no manager, no Settings screen, no tool registration and no tests**, confirmed by
  grep across `src/main/index.ts`, `src/preload/index.ts` and `Settings.tsx`. No
  Connectors UI ships, because an empty one would read as working.
- Streaming replies
- Tool routing into the agent loop
- Real update download+install (see L9)
- TEST MODE, PRODUCTION MODE, Release Readiness Engine
- Multi-project workspace, project registry
- Coin economy, account system, Google auth, admin roles

---

## RULES THIS AUDIT ENFORCES

1. `NOT_APPLICABLE` is **not** a failure. `BLOCKED` is **not** `FAILED`.
2. Only an *applicable* check that actually ran and failed may be reported as `FAILED`.
3. Never claim READY. Only the Release Readiness Engine may do that, and it does not exist yet.
4. Never claim something was tested when it was not — use `NOT_RUN` / `NOT_APPLICABLE` / `BLOCKED`.
5. Never report a fake balance, a fake test result, or a tool that does not do the real operation.
6. Every claim in a summary must trace to a row in this file.