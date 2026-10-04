# Cryptoric Agent — Working State

**Last updated:** Phase 5 (browser subsystem, all 43 tools) + Phase 6 (hosted model gateway) verified

---

## Verified commands

```bash
npx tsc -p tsconfig.node.json --noEmit   # exit 0
npx tsc -p tsconfig.web.json --noEmit    # exit 0
npx vitest run                           # 305 passed / 14 files
npx electron-vite build                  # exit 0
npx electron-vite dev                    # run the app
npm run test:browser                     # 59 checks in real Electron, http target
CRYPTORIC_BROWSER_TARGET=file npm run test:browser   # 50 checks, file target
npm run test:model                       # 6 checks against the live OpenRouter API
```

The live runs exceed the synchronous command timeout. Log to a file and read it back:

```bash
npm run test:browser > .review/tmp/live.log 2>&1; echo "EXIT=$?"
```

**Filtering output:** always `set -o pipefail` then `echo "EXIT=${PIPESTATUS[0]}"`. A passing filter is not a passing test.

**Kill stale Electron:** `taskkill //F //IM electron.exe`

---

## Repository

`C:\Users\Deadaaditya\Downloads\Cryptoric Agent` — path contains a space, always quote.

Branch `master`. Working tree must be clean at each checkpoint.

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

### Tool surface (46 registered)

- 12 filesystem — `read_file` `write_file` `append_file` `edit_file` `list_directory`
  `create_directory` `delete_file` `move_file` `file_exists` `file_metadata`
  `search_content` `search_files`
- 11 environment/process — `detect_runtime` `detect_package_manager` `install_runtime`
  `install_package_manager` `verify_runtime` `refresh_environment` `inspect_environment`
  `create_terminal_session` `list_running_processes` `stop_process` `restart_process`
- 23 browser — see below

`ToolContext` now carries `recordArtifact()` so a tool can point at a real file path.

### Execution infrastructure

`src/main/services/tools/exec.ts` — `runCaptured(command, args, {cwd, env, timeoutMs,
signal, onStdout, onStderr, maxOutputChars})` → `{code, stdout, stderr, truncated,
timedOut, cancelled}`. `shell: false`. **Not yet exposed as a tool.** Do not write a
second command executor; build `run_command` on this.

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
· `CRYPTORIC_SHOT_TASK=<prompt>` · `CRYPTORIC_DEBUG_DUMP=1`. Prints `CRYPTORIC_DUMP`
and `CRYPTORIC_STAGE_TEXT`, then quits. `.review/` is gitignored.

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

---

## Commit history

```
bc4ba54 Remove browser helpers nothing reaches
e29093f Give background tabs a render surface so screenshots are not blank
b01546d Give the agent a real browser built on Electron's own Chromium
44f26ef Replace the ad-hoc state file with a real settings subsystem
396817c Classify file content from a prefix instead of reading whole files
baf2d2a Give the agent a filesystem it cannot be trusted to misuse
167ab24 Give every tool call one enforced path: registry, runtime, router
a8be942 Rebuild the shell around a workspace-first visual language
```