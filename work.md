# Cryptoric Agent — Working State

**Last updated:** hosted model providers (APINEX + verified-free OpenRouter models),
transient-failure retry, and GitHub Releases application updates. Commit `6f7560f`,
pushed to `origin/main`, release `v0.1.0` published.

---

## Verified commands

```bash
npx tsc -p tsconfig.node.json --noEmit   # exit 0
npx tsc -p tsconfig.web.json --noEmit    # exit 0
npx vitest run                           # 383 passed / 16 files
npx electron-vite build                  # exit 0
npx electron-vite dev                    # run the app
npm run test:browser                     # 59 checks in real Electron, http target
CRYPTORIC_BROWSER_TARGET=file npm run test:browser   # 50 checks, file target
npm run test:model                       # 8 checks against the live OpenRouter API
npm run test:apinex                      # 18 checks against the live APINEX API
npm run test:agent                       # 13 checks: real model + real tools -> real files
npm run test:agent:apinex                # the same loop on a free APINEX model
npm run test:agent:laguna                # the same loop on OpenRouter Laguna S 2.1 (free)
npm run test:agent:ling                  # the same loop on OpenRouter Ling 3.1 Flash (free)
npm run test:command                     # 12 checks: real shells, refusals, cancellation
npm run test:migration                   # 3 checks: settings schema migration
```

`test:agent:*` take the provider as an **argument**, not an environment variable —
npm runs scripts under `cmd.exe` on Windows, where `VAR=value cmd` does nothing.

The live runs exceed the synchronous command timeout. Log to a file and read it back:

```bash
npm run test:browser > .review/tmp/live.log 2>&1; echo "EXIT=$?"
```

**Filtering output:** always `set -o pipefail` then `echo "EXIT=${PIPESTATUS[0]}"`. A passing filter is not a passing test.

**Kill stale Electron:** `taskkill //F //IM electron.exe`

---

## Repository

`C:\Users\Deadaaditya\Downloads\Cryptoric Agent` — path contains a space, always quote.

Local branch `master` tracks `origin/main` on `https://github.com/Itz-Npg/Cryptoric-Agent.git`.
Working tree must be clean at each checkpoint.

**Attribution:** commit messages carry no `Co-Authored-By:` trailer. GitHub adds
every co-author to the repository contributors graph, and the owner asked that no
Codebuff account appear there. Verified with
`gh api repos/Itz-Npg/Cryptoric-Agent/contributors` → `Itz-Npg` only. Do not add a
co-author trailer to any commit in this repository.

---

## Architecture as built

### Tool Runtime (DO NOT REPLACE)

`src/main/services/tools/runtime.ts` — every call follows one enforced order:
resolve → platform → dependencies → parse → **clamp to caller's tier** → policy →
approval → bounded execute → validate → redact → audit. Never throws; failures are
values carrying `failureKind`.

Two independent axes:
- `PermissionTier` — safe / ask / elevated / destructive — *who may call*
- `ToolRiskLevel` — safe / low / medium / high / critical — *blast radius*

A global `allow` in policy does **not** auto-approve above `safe`; approval is still
required. Timeout **wins a race** (`Promise.race`), so a non-cooperative tool cannot
hang the agent.

### Tool surface (55 registered)

- 12 filesystem — `read_file` `write_file` `append_file` `edit_file` `list_directory`
  `create_directory` `delete_file` `move_file` `file_exists` `file_metadata`
  `search_content` `search_files`
- 1 command — `run_command` (**new**; built on `exec.ts`, no second executor)
- 11 environment/process — `detect_runtime` `detect_package_manager` `install_runtime`
  `install_package_manager` `verify_runtime` `refresh_environment` `inspect_environment`
  `create_terminal_session` `list_running_processes` `stop_process` `restart_process`
- 43 browser — see below

`ToolContext` carries `recordArtifact()` so a tool can point at a real file path.

### Agent loop — `src/main/services/agent/` (NEW)

| File | Role |
|---|---|
| `loop.ts` | `runAgentLoop()` — model asks for a tool → `AgentRuntime.invoke` runs it → real result goes back → repeat. `buildToolSpecs()` offers the registry as OpenAI function definitions. |
| `conversation.ts` | `ConversationStore` — main-owned, atomic writes, bounded at 1000 turns, survives a corrupt file. `deriveTitle()` replaces `prompt.slice(0, 60)`. |
| `stages.ts` | The fixed pipeline around it. `model` is a `PipelineDeps` hook — present only when a provider is really configured. |
| `core.ts` | `AgentRuntime`. `invoke()` is **public**: the loop calls it, so the model never gets a path that skips policy. Tracks `changedPaths` from real tool results. |

**Rules the loop obeys.** Every tool call is answered, including malformed arguments and
unknown names. A failure is reported to the model as a failure. Bounded at 12 steps; a
provider failure ends the run instead of retrying it.

### Execution infrastructure

`src/main/services/tools/exec.ts` — `runCaptured(command, args, {cwd, env, timeoutMs,
signal, onStdout, onStderr, maxOutputChars})` → `{code, stdout, stderr, truncated,
timedOut, cancelled}`. `shell: false`. **Now exposed as `run_command`**
(`tools/builtin/command.ts`) — do not write a second command executor.

`run_command` notes: cwd is contained in the workspace; the permission tier is re-derived
from the real argv by `classifyCommand`; the executable is resolved on the managed PATH
first so "not installed" is a real `dependency-missing`. On Windows a `.cmd`/`.bat` is
exec'd through `cmd.exe`, and arguments containing `& | < > ^ % ! "` are **refused** —
cmd expands those inside double quotes, so quoting is not enough.

### Browser subsystem — `src/main/services/browser/`

| File | Role |
|---|---|
| `tabs.ts` | `BrowserTabManager`. One `WebContentsView` per tab, one persistent session each under `%APPDATA%/Cryptoric Agent/browser/<tabId>/`. Console + network capture, storage reporting, history, eviction. |
| `page.ts` | `PageController`. Isolated-world bridge calls, polling waits, CDP input dispatch, screenshots, accessibility tree. |
| `page-bridge.js` | Page-side helper, loaded via `?raw`, evaluated in isolated world `9999`. Synchronous only. |
| `keys.ts` | CDP key descriptor table, chord expansion, modifier bitmasks. |
| `dom.ts` | Pure helpers: URL normalisation, target classification, log levels, clipping. |
| `tools.ts` | The browser tool definitions. |
| `raw.d.ts` | `*.js?raw` module declaration for Vite. |

**Four hard-won facts. Do not undo them.**

1. A detached view reports `innerWidth: 0` and lays out nothing. `Emulation.setDeviceMetricsOverride`
   (with `Page.enable` first, `deviceScaleFactor: 1`) is the only thing that gives it a viewport.
   Re-assert it after every load — a navigation resets the override, and input then silently
   routes to the previous document.
2. `debugger.attach` must happen **before the first navigation**.
3. A chord's final key must **not** carry `text`, or `Ctrl+A` types a literal `A`.
4. Chromium only composites a window it has **actually shown**. The background host is a
   real window at `x:-32000, y:-32000` with `skipTaskbar` + `focusable:false`. Neither
   `show:false` nor `offscreen:true` produces a usable screenshot.

### Wiring in `src/main/index.ts`

`BrowserTabManager` constructed after `env` with `getWindow: () => mainWindow`.
`win.on('resize')` → `manager.layout(window)`. `before-quit` → `manager.closeAll()`.
`Services` interface gained `browser: BrowserTabManager`.

### UI boundary — FROZEN

`src/renderer/src/**` is approved and must not be redesigned, restyled or rearranged.
Only add UI when a genuinely new capability requires a control or result view.

### Debug hooks (`attachDesignReviewHooks`)

`CRYPTORIC_SHOT=<dir>` · `CRYPTORIC_SHOT_SIZE=WxH` · `CRYPTORIC_SHOT_PROJECT=<path>`
· `CRYPTORIC_SHOT_TASK=<prompt>` · `CRYPTORIC_SHOT_APPROVE=1` · `CRYPTORIC_DEBUG_DUMP=1`.
Prints `CRYPTORIC_DUMP`, `CRYPTORIC_STAGE_TEXT` and `CRYPTORIC_TASK_DONE`, then quits.
`.review/` is gitignored.

`CRYPTORIC_SHOT_TASK` **polls for a terminal task state** (up to 180 s) rather than
waiting a fixed delay — a fixed wait captured the agent mid-run and made a working agent
look broken.

`CRYPTORIC_SHOT_APPROVE=1` answers approval prompts for the duration of a review run and
is gated on `CRYPTORIC_SHOT` as well, so it cannot be reached by setting one variable in
a normal launch. It grants nothing persistent; the grant is the same session-scoped one
the "Allow for this session" button makes, and it dies with the process.

### Live browser check

`npm run test:browser` — bundles via `scripts/build-live-check.mjs` (esbuild + a `?raw`
plugin) and runs under real Electron against a real local server, through the real
`ToolRuntime`. 22 checks.

Env switches exist so the check stays honest on any machine:
- `CRYPTORIC_BROWSER_HOST=off` — disables the background render host
- `CRYPTORIC_BROWSER_TARGET=file` — loads the on-disk copy of the page

---

## Environment quirks discovered

- This machine's Chromium does **not** deliver synthesized input to renderers of
  *network* origins. Reproducible with a bare `WebContentsView` and raw
  `debugger.sendCommand`, no Cryptoric code involved. Not a product defect.
- Windows keeps a short-lived lock on a Chromium profile directory after close.
  Profile cleanup is async with backoff; a surviving directory is reported, not hidden.
- `write_file` needs `{path, instructions, content}` — omitting `instructions` throws.
- `str_replace` needs `replacements: [{oldString, newString}]`.
- `read_files` needs `paths: string[]`.
- **Node exits 13 on an unsettled top-level await**, with no error and no stack trace.
  A hung approval promise looks exactly like a crash. Always pump `ApprovalQueue` in a
  headless harness.
- `process.exit()` truncates buffered stdout on Windows when stdout is redirected to a
  file. Set `process.exitCode` instead, so the last lines of a failing run survive.

---

## Commit history

```
a57f4d3 Set the title where it actually wins
90c9864 Make packaging actually run
4b568ef Rename the packaged app to cryptoricagent and ship the supplied logo
a53a8a7 Give Chan a voice, and stop printing a lie about the model
87b1cb1 Give the agent a real browser built on Electron's own Chromium
bc4ba54 Remove browser helpers nothing reaches
e29093f Give background tabs a render surface so screenshots are not blank
b01546d Give the agent a real browser built on Electron's own Chromium
44f26ef Replace the ad-hoc state file with a real settings subsystem
396817c Classify file content from a prefix instead of reading whole files
baf2d2a Give the agent a filesystem it cannot be trusted to misuse
167ab24 Give every tool call one enforced path: registry, runtime, router
a8be942 Rebuild the shell around a workspace-first visual language
```