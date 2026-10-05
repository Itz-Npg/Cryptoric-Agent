# Cryptoric Agent

**An AI-native desktop development environment. Bring your own key. Nothing leaves your machine except your model requests.**

Cryptoric Agent is an Electron app that runs an agent loop against **your** model
provider — OpenRouter, APINEX, or anything OpenAI-compatible on your own machine
(Ollama, LM Studio, llama.cpp, vLLM). It ships no key, no account, and no backend.
You add your own key in Settings and it goes straight into the OS-encrypted
credential store.

> **Bring your own key.** There is no Cryptoric account, no Cryptoric server, and
> no Cryptoric-funded quota. Your requests go from your machine to the provider
> you chose, under your key.

---

## Screenshots

| | |
|---|---|
| ![Home](docs/screenshots/01-home.png) | ![Agent](docs/screenshots/02-agent.png) |
| **Home** — pick what you are building | **Cryptoric Chan** — the agent surface |
| ![Workspace](docs/screenshots/03-workspace.png) | ![Environment](docs/screenshots/04-environment.png) |
| **Workspace** — files, changes, terminal, processes | **Environment** — detects and installs runtimes |
| ![Settings](docs/screenshots/05-settings.png) | ![Palette](docs/screenshots/06-command-palette.png) |
| **Settings** — provider, models, permissions | **Command palette** — ⌘K |

<sub>Captured from a clean profile, so no credential or personal path appears in
any of them.</sub>

---

## What it actually does

The agent runs a real loop, not a scripted demo. It is given the live tool
registry, asks for a tool, the tool runs through a real runtime that enforces
policy and approval, and the **actual result** goes back to the model.

```
prompt → model → tool request → real tool → structured result → model → …
                                                                        ↓
                                            verify → review → final status
```

**The part that matters: it reports what happened, not what it intended.**

A stage completing proves the stage ran — nothing more. Cryptoric Agent
therefore measures the filesystem before and after an implementation stage,
hashes it, and refuses to report `COMPLETED` unless something actually changed.
A run that changes nothing is `BLOCKED`, with a named reason:

```
Blocked — nothing was implemented. I did not change anything. I answered in
prose without using a file or command tool, which does not implement the request.
```

> This is not theoretical. The bug that rule exists to prevent shipped: a request
> to build a landing page returned **"Task complete — no files were changed"**
> with all five stages ticked green at `0 ms`. The engine had `continue: true` on
> a no-op and never checked whether the *task* was done. See
> [`audit.md`](audit.md).

### Stages

`analyze → plan → implement → verify → review`

- **analyze** — reads the project's real manifests and probes the real runtimes.
- **plan** — the model plans, or a labelled keyword outline when none is configured.
- **implement** — the model acts through the tool registry. **Snapshot before and
  after; mutation is verified, not assumed.**
- **verify** — runs the project's *own* declared `typecheck` / `lint` / `test` /
  `build` through `run_command` and reports real exit codes. A check the project
  does not declare reports `SKIPPED`; no checks at all reports
  `NO_TEST_SUITE_FOUND`. Neither is ever rendered as a pass.
- **review** — lists the files that actually changed, read from the diff.

### Safety

Every tool call goes through one runtime that owns tier clamping, approval,
timeout, cancellation, redaction and audit. The model chooses a tool; it cannot
raise a tool's tier. Permissions are visible per domain in Settings
(`fs.read`, `fs.write`, `terminal.elevated`, …).

---

## Status — honestly

**Works, and verified against a live provider:**

- Agent loop with real tools — `npm run test:agent` → **13/13**
- Full stage pipeline incl. the evidence gate — `npm run test:agent:pipeline` → **8/8**
- Coin allowance rules — 14 tests in `tests/unit/coins.test.ts`
- Watchdogs on every model call, tool call and stage. No unbounded `await`.
- Hard ceilings: 30 iterations, 40 model calls, 100 tool calls, 30 min — each
  reported, never silently extended.
- `NO_PROGRESS_LOOP` detection, heartbeat, structured execution log.
- Runtime detection and install, file/command/git tools, permission policy.
- Cross-platform CI producing Windows `.exe`, macOS `.dmg` (x64 + arm64), Linux
  `.AppImage` and `.deb`.

**Not done — stated rather than implied:**

- **Browser automation does not exist.** The verify stage reports
  `browser: NOT RUN`. There is no browser tool in this build.
- **Runtime installation is Windows-only.** Every installer id is `-winget`;
  there is no apt or brew route. On macOS/Linux the product correctly refuses.
- **Binaries are unsigned.** SmartScreen warns, Gatekeeper blocks on first open.
- **Multi-project workspaces** — persistence scoping exists; the UI does not.
- **`npm run lint` exits 1** on ~350 pre-existing errors in untouched files.

---

## Install

Download a release for your platform from
[**Releases**](https://github.com/Itz-Npg/Cryptoric-Agent/releases), or build it
yourself:

```bash
git clone https://github.com/Itz-Npg/Cryptoric-Agent.git
cd Cryptoric-Agent
npm ci
npm run dev
```

Requires **Node ≥ 20.11.0**.

### Package it

```bash
npm run dist          # current platform
npm run dist:win      # Windows NSIS installer
```

> ### ⚠️ Read this before you distribute anything
>
> `npm run dist` runs `scripts/stage-keys.mjs`, which copies a root `.env` into
> the build so **your key ships inside the binary**.
>
> **`.asar` is not a security boundary.** Your key is recoverable from the
> installer with a single `grep`. Verified on this project:
>
> ```bash
> grep -ao "sk-or-v1-[a-zA-Z0-9]*" resources/app.asar
> ```
>
> This is fine for an installer you use yourself and **unacceptable for anything
> you hand to someone else**. CI deliberately never runs this step, which is why
> published releases carry no key.
>
> **The staged file lives inside the packaged directory.** `electron-builder`
> copies `out/`, so a `out/cryptoric-keys.env` left behind by an earlier
> `npm run dist` will be baked into the *next* build too — including one that
> never asked for a key. That is not hypothetical: it happened here, and the key
> was recovered from a package built by `npx electron-builder` with no staging
> step in the command at all.
>
> So before packaging anything you intend to give away:
>
> ```bash
> rm -f out/cryptoric-keys.env     # or run `npm run build`, which recreates out/
> npx electron-builder --publish never
> ```
>
> `stage-keys.mjs` now also deletes a stale copy when there is no `.env`, so
> `npm run dist` cannot leave one behind by accident.

---

## Bring your own key

Three ways, in order of how much you should trust them:

**1. The app (recommended).** Open **Settings → Provider key → Add key**. It is
written to the OS-encrypted credential store — Credential Manager on Windows,
Keychain on macOS, libsecret on Linux — and never to a plaintext file. **Verify
key** makes a live request to the provider to confirm it actually works, which is
different from the field merely being filled in.

**2. A local `.env`** (gitignored, never committed):

```bash
cp .env.example .env
# OPENROUTER_API_KEY=sk-or-v1-...
# APINEX_API_KEY=...
```

Read at runtime by `src/main/services/models/dotenv.ts`. Useful for scripted
development; see the warning above before packaging it.

**3. A local model.** Point the endpoint at Ollama or LM Studio and leave the key
blank. Local models are never metered.

### Coins

If you have no key of your own, Cryptoric-funded usage draws on a coin allowance:

- **25 coins** on the first day, granted once to a new profile.
- **20 coins** on every day after that.

When the allowance runs out, the call is refused with a message that says so and
names both ways out — tomorrow, or adding your own key. A user's own provider key
is **never** charged: `metered` is false when a key is present, so this ceiling
simply does not apply to you.

> **Honest caveat:** coins currently meter almost nothing. They only apply to
> usage Cryptoric pays for, and there is no Cryptoric-funded provider yet — so in
> practice a user with their own key never sees the limit, and a user without one
> is refused for a missing credential first. The arithmetic and the messaging are
> real and tested ([`shared/coins.ts`](src/shared/coins.ts), 14 tests); the
> balance behind them is local, not server-authoritative.

### Providers

| Provider | Key | Notes |
|---|---|---|
| OpenRouter | `OPENROUTER_API_KEY` | 20+ models; the free `:free` ones cost nothing |
| APINEX | `APINEX_API_KEY` | 5 verified models |
| Ollama / LM Studio | *(none)* | Local; never metered |

---

## How it's built

Electron 33 · React 18 · TypeScript · electron-vite · electron-builder 25

```
src/main/services/agent/
  execution.ts   state machine, ceilings, failure classification  (imports nothing)
  evidence.ts    intent classification, snapshot diff, final-status rule
  snapshot.ts    content-hashed before/after filesystem diff
  loop.ts        the agent loop: watchdogs, limits, no-progress detection
  core.ts        task runtime, stage boundaries, cancellation
  stages.ts      analyze / plan / implement / verify / review

src/main/services/tools/
  runtime.ts     the single enforcement path: policy, approval, timeout, redaction
  builtin/       filesystem, command, environment tools

src/main/services/models/
  gateway.ts     OpenAI-compatible client, bounded retry, usage accounting
```

`execution.ts` and `evidence.ts` **import nothing**. That is deliberate: the lines
that decide whether a task is finished, and whether it counts as done, are the
ones that shipped wrong twice. Both are reachable by a test.

```bash
npm run typecheck   # 0 errors
npm test            # 518 tests / 20 files
npm run build
```

---

## Contributing

Issues and PRs welcome. Two things will be held to:

**No fabricated progress.** A stage may not report success it did not observe. A
test may not pass because an assertion was loosened. A status may not be renamed
instead of fixed. This project has shipped both halves of that bug — a
"verification" stage that ran nothing, and a tick that appeared at stage *start*
— and both are written up in [`audit.md`](audit.md) because the recurrence is
the point.

**Commits carry no co-author trailers.** GitHub adds every co-author to the
contributors graph, and this project is meant to have exactly one.

---

## License

[MIT](LICENSE) © 2026 Itz-Npg