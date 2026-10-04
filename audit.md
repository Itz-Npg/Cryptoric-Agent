# Cryptoric Agent — Verification Audit

Every claim below is backed by a command that was actually run. Anything not verified
is marked **NOT VERIFIED**. Nothing here is inferred from reading code.

Last audit: browser subsystem + hosted model gateway, uncommitted working tree over `bc4ba54`.

---

## PASSING

| Check | Command | Result |
|---|---|---|
| Typecheck, main | `npx tsc -p tsconfig.node.json --noEmit` | exit 0 |
| Typecheck, web | `npx tsc -p tsconfig.web.json --noEmit` | exit 0 |
| Unit tests | `npx vitest run` | 305 passed, 14 files, exit 0 |
| Production build | `npx electron-vite build` | exit 0 |
| Lint, files touched this change | `npx eslint <changed paths>` | 0 errors (6 pre-existing `no-console` warnings in `src/main/index.ts`) |
| Lint, whole repo | `npm run lint` | **exit 1 — 350 pre-existing errors**, none in the files changed here |
| Browser, live, http target | `npm run test:browser` | **59 pass / 0 fail** |
| Browser, live, file target | `CRYPTORIC_BROWSER_TARGET=file npm run test:browser` | **50 pass / 0 fail** (9 http-only checks report as skipped, not passed) |
| Model gateway, live provider | `npm run test:model` | **6 pass / 0 fail** against `api.openrouter.ai` |
| Toast appears and leaves | `CRYPTORIC_SHOT_TOAST=1 npx electron .` | `CRYPTORIC_TOAST_SHOWN "Environment refreshed to snapshot 2…"` then `CRYPTORIC_TOAST_AFTER_TIMEOUT dismissed` |
| Chan answers a prompt | `CRYPTORIC_SHOT_TASK="hi" npx electron .` | real window DOM text: `Cryptoric Chan / Hi! How can I help? / No project is open.` |

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
| L5 | Router exists and is tested but the pipeline still runs a fixed stage list. | By inspection. | Real gap. |

---

## NOT IMPLEMENTED (stated plainly, never dressed up)

- `run_command` — `exec.ts` is written and unused
- Build runner, test runner, diff engine, Git toolset
- Code intelligence / symbol index
- Project capability detection, test applicability engine
- Process start, port manager, resource limits
- Visual regression, responsive testing, accessibility audit, performance observation
- API testing, database testing, Docker, network diagnostics
- Security scanning, dependency auditing
- MCP / connectors
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