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

### Browser

The agent drives a real Chromium. **43 browser tools** are registered, from
`browser_create_tab` and `browser_navigate` through typing, clicking, dragging,
uploading, downloads, dialogs, permissions, cookies, storage, console capture
and network-failure capture.

This is not a stub and not a mock. `npm run test:browser` runs **59 checks
against real Chromium in a real Electron main process**, driving the same tool
definitions through the same `ToolRuntime` that enforces tiers, approvals,
redaction and audit — the `verify` and `redact` guards below are proved there,
not asserted.

That check needs a real desktop session and **does not run in CI**. It was
attempted there under `xvfb` and failed for a specific reason, written up in the
workflow file: a `WebContentsView` with nothing composited behind it accepts no
real pointer input and does not answer `capturePage`, so every read-only tool
passed while `browser_click`, `browser_drag`, `browser_screenshot` and link
navigation did not. Software-rendering switches did not change that. Marking the
job `continue-on-error` would put a green tick over a red run, so it was removed
rather than dressed up. **Until this is solved, a browser regression can reach
`main` undetected.**

The verify stage uses it too. When a task changes web files, the stage opens the
page for real and fails the task on console errors or failed requests. It
reports five distinct outcomes — `PASSED`, `FAILED`, `NOT RUN`,
`NOT APPLICABLE`, `ERROR` — because "no browser was needed", "this build has no
browser" and "the browser could not be reached" are three different facts, and
collapsing them into one is how a stage ends up denying a capability the build
has.

---

## Status — honestly

**Works, and verified against a live provider:**

- Agent loop with real tools — `npm run test:agent` → **13/13**
- Full stage pipeline incl. the evidence gate — `npm run test:agent:pipeline` → **8/8**
- **Integrated browser** — `npm run test:browser` → **64/64 against real Chromium**,
  44 tools. Desktop only; see the limitation below.
- **iOS companion** — `swift build` + `swift test` green on a GitHub macOS
  runner. The job fails unless the suite reports `Executed N tests` with N ≥ 10.
- **`cryptoric` CLI** — the same pipeline, headless. 24 tools, one 398 KB file,
  no Electron. A real task run returns exit **2 `BLOCKED`** and writes nothing
  when no model is configured, rather than reporting success.
- Release signing — sign and verify round trip on the real 188 MB installer;
  public key in [`docs/signing/`](docs/signing/SIGNING.md)
- Coin allowance rules — 14 tests in `tests/unit/coins.test.ts`
- Watchdogs on every model call, tool call and stage. No unbounded `await`.
- Hard ceilings: 30 iterations, 40 model calls, 100 tool calls, 30 min — each
  reported, never silently extended.
- `NO_PROGRESS_LOOP` detection, heartbeat, structured execution log.
- Runtime detection and install, file/command/git tools, permission policy.
- Cross-platform CI producing Windows `.exe`, macOS `.dmg` (x64 + arm64), Linux
  `.AppImage` and `.deb`.

**Not done — stated rather than implied:**

- **The browser check does not run in CI.** It passes 64/64 on a desktop, but
  under `xvfb` the five tools that need a real pointer path or a composited
  surface fail. Tried and rejected: software-rendering switches. There is no
  headless variant, and inventing one would mean testing a fake. Until it runs,
  browser regressions are not caught before `main`.
- **Runtime installation is Windows-only.** Every installer id is `-winget`;
  there is no apt or brew route. On macOS/Linux the product correctly refuses.
- **Binaries carry no Authenticode signature.** They are GPG-signed, which
  proves provenance but does not clear SmartScreen — see
  [`docs/signing/SIGNING.md`](docs/signing/SIGNING.md).
- **The CLI has never run against a live model provider.** Every CLI result in
  this README was produced with no API key set. That is the path that must
  refuse to claim success, and it does — but the model path itself is untested
  end-to-end.
- **The iOS app is not distributed.** It compiles and its tests pass in CI.
  App Store or TestFlight needs a paid Apple Developer account, so nothing here
  puts an app on a phone.
### Bring your own API

Settings → Models → **Add provider**. Pick the provider from a searchable list
(OpenRouter, OpenAI, Ollama, LM Studio, Groq, Together, Mistral, DeepSeek, or
Custom) and the base URL and a real model id are filled in for you.

Three things stay deliberately separate, because they are three different kinds
of thing:

- **Base URL** — prefilled from your choice, and still editable. A preset is a
  shortcut, not a restriction, so your own gateway is always allowed.
- **API key** — written straight to the OS credential store. Never in settings,
  never in a project file, never sent back to the renderer. Local servers are
  not asked for one.
- **Model ID** — copy it from the provider rather than guessing; a wrong id
  fails as a 404 with nothing useful in it.

Extra models and a custom name sit under **Advanced settings**. Editing a
provider never makes you retype its stored key, and saving the same name again
updates it rather than creating a duplicate.

### Your own model server

Run the provider server and point installs at it; the models you publish there appear
in the picker. Opt-in, no dependencies, and the security properties are enforced in
code rather than documented: the token is mandatory (the server exits without one),
compared in constant time, and **your upstream key never reaches a client**.

```bash
PROVIDER_TOKEN=$(openssl rand -hex 32) node server/index.mjs
```

Full detail in [`server/README.md`](server/README.md).

- **Multi-project workspaces** — execution is genuinely parallel (separate folders
  run at once, one folder still serialises), and each project has its own
  `.cryptoricagent/` history. The **sidebar UI** to switch between them does not
  exist yet.
- **`npm run lint` exits 1** on ~350 pre-existing errors in untouched files.

---

## The CLI

The same agent, in a terminal. Not a port — the desktop app and `cryptoric` are
two composition roots over one implementation, so a change to the pipeline
reaches both.

![A real cryptoric session: the CRYPTORIC wordmark, a task typed into the prompt box, and a BLOCKED verdict because no model provider is configured](docs/images/cli-session.svg)

<sub>A real capture from `node scripts/capture-cli-svg.mjs`, with no model
provider configured — which is why it honestly ends in BLOCKED.</sub>

```bash
cryptoric                     # prompt box: type a task, get a result
cryptoric run "<task>"        # one shot, for scripts and CI
cryptoric tools               # what this CLI can actually call
cryptoric doctor              # environment and configuration
```

Inside a session: `/tools`, `/doctor`, `/cwd`, `/exit`.

State lives in `CRYPTORIC_HOME` (default `~/.cryptoric`), the API key comes from
`CRYPTORIC_API_KEY` and is never written to disk, and gated operations prompt on
stdin — refusing outright when stdin is not a terminal, because an absent human
is not consent.

The conversation is scoped per project and written to disk, so a task you ran
yesterday is still in the history after a restart. Exit codes distinguish what
the pipeline actually concluded: `0` COMPLETED, `1` FAILED, `2` BLOCKED,
`3` CANCELLED, `4` PARTIAL, `64` bad usage. **A run with no observed file change
is never `0`.**

Browser tools are absent rather than stubbed — they need a window. Full detail in
[`cli/README.md`](cli/README.md).

---

## Install

Download a release for your platform from
[**Releases**](https://github.com/Itz-Npg/Cryptoric-Agent/releases), or build it
yourself. Every published installer ships with a detached OpenPGP signature —
**check it**, see [Verifying a download](#verifying-a-download).

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

## Code signing

### Verifying a download

Every artifact on the Releases page has a matching `.asc` detached OpenPGP
signature. To check that what you downloaded is what the project published:

```bash
npm run verify:release -- ~/Downloads/CryptoricAgent-0.1.4-x64-setup.exe
```

or without a checkout:

```bash
gpg --keyserver keyserver.ubuntu.com --recv-keys 0A0BDF9C7A1C544D22505E4BC91B55788C7458A1
gpg --verify CryptoricAgent-0.1.4-x64-setup.exe.asc CryptoricAgent-0.1.4-x64-setup.exe
```

The public key is committed at
[`docs/signing/cryptoric-agent-signing-key.asc`](docs/signing/cryptoric-agent-signing-key.asc).
An OpenPGP signature proves provenance. It does **not** silence Windows
SmartScreen or macOS Gatekeeper — that needs a certificate from a recognised
authority, which is a separate process described in
[`docs/signing/SIGNING.md`](docs/signing/SIGNING.md).

Full instructions, including how to sign your own build and how the Linux and
macOS paths work: [`docs/signing/SIGNING.md`](docs/signing/SIGNING.md).

### Code signing policy

**Code signing policy.** Release artifacts are signed only by the automated
release pipeline in [`.github/workflows/release.yml`](.github/workflows/release.yml),
on a `v*` tag whose version matches `package.json`. Signing requires the
repository secret `CRYPTORIC_GPG_KEY`, which is readable only by repository
administrators — the same trust boundary as being able to publish a release. The
pipeline pins the signing key fingerprint
`0A0BDF9C7A1C544D22505E4BC91B55788C7458A1`, so a substituted key is rejected
before anything is signed rather than silently used.

Contributors never receive access to the signing key and cannot produce a signed
build. Forks and pull requests cannot either. Locally built artifacts are
unsigned, and that is expected rather than a defect.

This project uses an OSI-approved licence (MIT), contains no proprietary code in
its distributed artifacts, is maintained and already released, and is not a
hacking tool. The full policy, including key management and revocation, is at
[`docs/signing/CODE_SIGNING_POLICY.md`](docs/signing/CODE_SIGNING_POLICY.md).

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