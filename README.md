# Cryptoric Agent

**An AI-native development environment — a desktop app, a CLI, and a mobile
companion that all run the same agent. You bring the model.**

Cryptoric Agent runs an agent loop against **your** provider — OpenRouter, APINEX,
or anything OpenAI-compatible, including one on your own machine (Ollama,
LM Studio, llama.cpp, vLLM). It ships no key and no account. Three surfaces share
one pipeline:

| Surface | What it is | State |
|---|---|---|
| **Desktop** | Electron app, agent + browser + terminal | Ships as `.exe`, `.dmg`, `.AppImage`, `.deb` |
| **CLI** | `cryptoric`, one 485 KB file, no Electron | Verified; not yet on npm |
| **Mobile** | Swift companion + Node relay | **Library and tests only — no app ships** |

> **Bring your own key.** There is no Cryptoric account and no Cryptoric-funded
> quota. Requests go from your machine to the provider you chose, under your key.
> If you run a provider server yourself, your upstream key never reaches a
> client — see [Your own model server](#your-own-model-server).

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

The CLI session below is a **recording, not a mockup**.
[`scripts/capture-cli-svg.mjs`](scripts/capture-cli-svg.mjs) runs the real CLI
and renders whatever came back; CI re-runs it and fails if the committed SVG has
drifted.

![A real cryptoric session](docs/images/cli-session.svg)

It shows a `BLOCKED` verdict, because at capture time no model was configured.
That is the point: the session that cannot do the work says so instead of
implying success.

---

## What it actually does

You describe a task. The agent plans it, executes it against real tools, and
reports **what it observed** — not what it intended.

### Stages

Each stage has a declared permission ceiling, and each is entered and exited in
the transcript separately. That is deliberate: the UI used to tick a stage the
instant it *began*, so a task sitting inside implementation for ten minutes
showed a green tick the whole time.

### Safety

Every tool call goes through one runtime that owns policy, approval, timeout,
cancellation, redaction and audit. The agent never gets a second path. The threat
model is written down in [`docs/security-review.md`](docs/security-review.md)
and it describes the code as it is, including what is still open.

The parts worth naming:

- **Paths are checked twice: as text, and as what they resolve to.** A symlink
  inside the workspace pointing outside it passes a textual check and the kernel
  follows it anyway, so containment is re-established on the real path —
  dangling-link targets included — and a path that cannot be resolved is
  refused rather than allowed.
- **"Allow for this session" is scoped, capped and it expires.** The grant
  records the tier you actually saw in the dialog, so approving an `ask`-tier
  tool does not quietly authorise a `destructive` one in the same domain, and it
  lapses after four hours rather than surviving a weekend. A configured `deny`
  outranks it.
- **Credentials in your shell are not handed to your repo's build scripts.**
  The inherited environment is filtered on the way in, so `GITHUB_TOKEN`,
  `AWS_SECRET_ACCESS_KEY` and `NPM_TOKEN` are not passed to a `postinstall`
  hook the agent happened to trigger. What you map into a project layer passes
  through untouched, and `CRYPTORIC_PASS_ENV` names anything to re-admit.
- **Tool output is redacted before it reaches the model or the transcript,**
  including the `data` slot that carries file contents and command output — a
  secret printed by `cat .env` does not survive into the conversation.
- **Transcribing is append-only and private.** Transcripts, the session ledger
  and the audit trail are written `0600`, and every tool call is appended to
  `<userData>/audit.jsonl` rather than living only in a 500-entry ring buffer.
- **Links leave through an allowlist.** `shell.openExternal` is a process
  launcher on Windows, so only `https:`, `http:` and `mailto:` are handed to it.

### The tool surface

**80 tools in the desktop app, 36 in the CLI**, from one registry — so a
capability is written once and its policy is enforced in one place.

| Family | Tools | What it is for |
|---|---|---|
| Files | 13 | read one or many, write, edit, move, delete, search; every path resolved and re-checked against the open project |
| Patches | 1 | `apply_patch` — Codex-style create/update/delete hunks; a hunk that matches zero or several places is refused, so a wrong patch fails loudly |
| Environment | 11 | detect, install and verify runtimes; supervise terminals and processes |
| Git | 4 | `git_status`, `git_diff`, `git_log`, `git_commit` — see what changed, then record it |
| Project | 2 | `analyze_project` orientates on a repository it has not seen; `run_tests` runs the suite the project already declares |
| Research | 2 | `web_fetch` reads one http(s) page as text; `web_search` queries the web (keyless by default, Google-quality with a `SERPER_API_KEY`) |
| Agent process | 2 | `think_deeply` records reasoning before acting; `write_todos` keeps the ordered plan visible and updated |
| Command | 1 | `run_command` — argv, never a shell string |
| Browser | 44 | desktop only: it drives a real `WebContentsView`, so the CLI does not offer it |

The three read-only git tools are `safe`; `git_commit` is `ask`, and it stages
only the paths it was given unless told otherwise. **No tool can rewrite history
or publish**: `push`, `reset --hard`, `clean` and force are not exposed at any
tier, so a prompt-injected model cannot reach them by asking.

`web_fetch` follows redirects by hand — five at most — and re-checks every hop,
because a permitted host is not a licence for wherever it points next. Cloud
metadata addresses are refused outright; loopback and private addresses are
allowed, because checking your own dev server is the main reason the tool
exists. Bodies are read under a byte cap and cancelled once it is reached, and
the content type decides whether the bytes are text at all.

**Children get an expanded environment.** The machine PATH is stored in the
registry as `REG_EXPAND_SZ` and Windows expands it when it composes a process
environment. Reading it raw put a literal `%SystemRoot%\system32` on the PATH of
every spawned child, which made `npm run <script>` fail with
`ENOENT spawn %SystemRoot%\system32\cmd.exe` — npm shells out to cmd through
that very entry. It is expanded now, and where no variable is found the text is
left as written rather than silently emptied.

### Browser

**44 browser tools**, driven by a real `WebContentsView`. Design Mode adds
`browser_inspect_element`: it returns markup, computed style and a selector for
the element you point at, atomically, so you can act on what is actually on
screen.

The verification stage reports one of five outcomes — `pass`, `fail`, `unknown`,
`not-applicable`, `error` — and **an observation it could not make is `unknown`,
never `pass`**.

### The prompt bar

One composer, everywhere you can type: the first page and the chat are the same
control, so a habit learned in one works in the other.

- **`@` lists the files in the open project**, from the same search the Files
  pane uses. Picking one writes the relative path into the prompt, which is a
  reference the model can actually follow — no remembering paths.
- **`/` lists your enabled skills**, which is what the agent already routes on,
  so the menu offers the commands that will work and nothing else.
- **The model tile switches models for real.** The bar has no way to switch one
  by itself, so the choice is applied before the task starts: the model named on
the tile is the model that runs it.
- **The tile that sends is the tile that stops.** While a task is in flight its
  arrow morphs into a stop square and the same click halts the run.
- **Enter sends, Shift+Enter breaks the line**, and an IME composition owns
  Enter until it is finished — otherwise picking a candidate submits the prompt.

The effort slider is **not** enabled, and neither is the microphone: this app has
no reasoning-budget setting and no dictation backend, and a control that does
nothing is worse than an absent one.

### History on the first page

The first screen is not a blank prompt. It shows your recent projects and the last
few things you actually asked in the open one — read from the same store the chat
reads, so there is one history rather than two that can disagree. Choosing a
project out of that list lands on Chan, because a project chosen from your own
history was chosen to continue the conversation.

### Projects, history and parallelism

Opening a folder creates `<root>/.cryptoricagent/` holding a stable project id
and the transcript. The folder writes its own `.gitignore` containing `*`, so it
never shows up as untracked noise in your repo.

The app-folder copy is keyed by project id, and a transcript is never written to
a relative path: with nothing open, the app copy carries the session on its own.
It used to resolve `conversation.json` against the process's working directory,
which left a stray transcript next to the executable and read it back as the
user's conversation on the next launch.

History location is a setting: **app folder**, **project folder**, or **both**
(default). Multiple projects run in **parallel**, and two tasks in the *same*
folder never overlap — that guarantee is what stops two agents overwriting each
other's files, and it is tested by counting tasks inside a critical section, not
by measuring how long they took.

**Worktree isolation** goes one step further, and it is off by default because
it changes what the agent can see: each task gets its own `git worktree` at the
last commit, on a branch of its own (`cryptoric/…`), outside the project folder.
Every tool call the task makes resolves inside that checkout, so your working
tree is untouched and the task's changes are one reviewable branch instead of a
diff mixed in with whatever else you had open. What it cannot do is see work you
have not committed — that is the trade, so it is a choice rather than a default.
Turn it on with `sessions.worktreeIsolation` in `settings.json`, or `CRYPTORIC_WORKTREE_ISOLATION=1` in the CLI.

Checkouts are **kept** when a task ends: deleting one would delete the work. They
live under the app's user-data folder — `$CRYPTORIC_HOME/worktrees` for the CLI —
and there is no in-app list of them yet, so tidying up is `git worktree list`,
`git worktree remove <path>` and `git branch -D <branch>`. Removing a checkout
refuses when it has uncommitted changes unless it is forced, and the branch
survives either way. A task that *cannot* be isolated — a folder
that is not a repository, or one with no commits to branch from — is `BLOCKED`
with the reason on its timeline before any session is bought, rather than quietly
running in your folder after you asked it not to.

### Session time, in coins

**5 coins buys 30 minutes.** One coin is six minutes. Each model costs between
**5 and 10** — 5 for one you brought yourself or run locally, 10 for one Cryptoric
pays for, and never below 5.

The block is charged when a task starts, not per request, so a session is
predictable. With **no coins the agent does not run**: the charge happens before
the first tool call, and the task is marked `BLOCKED` with the reason. The bought
time *is* the agent loop's runtime ceiling, so the same mechanism that stops a
runaway task stops an exhausted one.

Close the app mid-task and it **resumes on launch**, on the session already
paid for — reopening never charges twice.

### Coins

**20 coins a day**, plus a **25 coin** one-time signup bonus that replaces that
day's allowance rather than adding to it. A user with their own key is never
metered.

---

## Bring your own API

Settings → Models → **Add provider**. Pick from a searchable list — OpenRouter,
OpenAI, Ollama, LM Studio, Groq, Together, Mistral, DeepSeek, or Custom — and the
base URL and a model id are filled in for you. A preset is a shortcut, not a
restriction: the URL stays editable, so your own gateway is always allowed.

- **Base URL** — validated before anything is sent.
- **API key** — a password field with a Show toggle, written straight to the OS
  credential store. Never in settings, never in a project file, never sent back
  to the renderer. Local servers are not asked for one.
- **Model ID** — copied from the provider, because a wrong id is a 404 with
  nothing useful in it.

Under **Advanced settings**: a connection name, extra models, and two optional
token budgets.

**Context window tokens** and **Maximum output tokens** are limits *you*
declare, not capabilities the app detects. The ceiling clamps every reply — a
stage that wants a short summary still gets one. A conversation longer than the
window is stopped with both numbers in the message, rather than being sent and
rejected opaquely. Leave them blank and the model stays uncapped.

Rules that exist because the alternative fails quietly:

- Each provider gets its **own** credential slot; a shared one would mean
  removing a provider deletes another's key.
- Provider ids are **slugged**, so a crafted name cannot address another
  provider's secret.
- A key pasted into a URL is **rejected** — it would otherwise land in settings,
  logs and any crash report.
- Saving the same name **updates** rather than duplicating; editing never makes
  you retype a stored key.

### Google sign-in

Sign-in uses OAuth 2.0 **authorization code with PKCE** through the system
browser, with the callback received on `http://127.0.0.1:53123/callback`. To
enable it:

1. Create an OAuth client in Google Cloud Console. A **Desktop** client type is
   the natural fit; a Web-application client also works if its secret is
   provided.
2. Register `http://127.0.0.1:53123/callback` as an Authorized redirect URI.
3. Put the credentials in a `.env` file at the project root (dev) or in the app
   data folder:

   ```
   GOOGLE_CLIENT_ID=…apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-…   # optional for a Desktop client
   ```

The client secret is never required for the desktop flow — PKCE replaces it —
and when configured it is only sent to Google's token endpoint. A refused
sign-in reports Google's own reason plus the setup step that fixes it (for
example, registering the redirect URI) instead of a bare error code.

---

## Your own model server

`server/index.mjs`, zero dependencies. You run it, installs point at it, and the
models you publish appear in the app. Installs fetch a catalogue and a token for
*your* server; **your upstream key never reaches a client.**

The security properties are enforced in code, not just written down:

- The token is **mandatory** — the server refuses to start without one, because
  an unauthenticated provider server is an open proxy to your upstream key.
- Comparison is **constant-time**, so the token cannot be leaked a character at
  a time.
- Request bodies are **capped**.
- The client **refuses to send its token over plain `http:`** to a non-loopback
  host, with an explicit opt-out for a trusted LAN.

17 tests start the real server and fetch it over loopback.

---

## The CLI

```bash
cryptoric                    # interactive session: type a task, get a verdict
cryptoric run "<task>"       # one-shot, exits non-zero when the work is blocked
cryptoric run "<task>" --json
```

The same pipeline, the same tools, the same verdicts — assembled around argv and
a pipe instead of a window. One file — 485 KB as the bundler reports it — with
no Electron, built with the esbuild already in the repo so it installs nothing
extra.It has **36 tools**: files (including multi-file reads and `apply_patch`),
environment, git, the project tools (`analyze_project` and `run_tests`),
`web_fetch`, `web_search`, the agent-process tools, and `run_command`. The one
family missing is the browser's, and it is missing rather than stubbed — those
tools are backed by a window, so `cryptoric tools` says so instead of offering a
tool that always fails.

A model is picked up from the environment **or a `.env` file** — the same file
the desktop app reads. With the default provider only `CRYPTORIC_API_KEY` is
required; the OpenRouter endpoint and a free catalogue model are assumed, and
`CRYPTORIC_ENDPOINT` / `CRYPTORIC_MODEL` still override them.

With no model configured it exits **2** and reports `BLOCKED` with a reason.
`--json` carries that reason too; an earlier build returned a verdict with
`reason: null`, which is a bug this repository caught in its own CI.

`CRYPTORIC_WORKTREE_ISOLATION=1` gives each run its own checkout, as above,
rooted at `$CRYPTORIC_HOME/worktrees`. Off unless set.

![A real cryptoric session](docs/images/cli-session.svg)

---

## The mobile companion

**An `.ipa` and an `.apk` both build on every push, and both ship with every release.**

What exists, all of it verified on GitHub runners:

- `mobile/ios` — a Swift package (`CryptoricKit`) holding the relay protocol,
  client and SwiftUI views. The job **fails** unless the suite reports
  `Executed N tests` with N ≥ 10.
- `mobile/ios-app` — the Xcode **app target** that turns that library into an
  `.app`: a SwiftUI entry point plus a `URLSessionWebSocketTask` transport.
- `mobile/android` — a real Gradle project: manifest, one activity, an OkHttp
  relay client, and its **7 unit tests** against the same relay protocol cases
  the JavaScript and Swift suites use.
- `scripts/build-ios-ipa.sh` and `scripts/build-android-apk.sh` — one script
  each, run by `mobile.yml` on every push **and** by `release.yml` on a tag, so
  a published artifact is built by the steps that were verified on every commit
  rather than by a second implementation that could drift.
- `mobile/relay` — a zero-dependency Node relay, **17/17** tests.

Both builds assert more than an exit code. The iOS job checks `BUILD SUCCEEDED`,
that an `.app` exists, that the archive is over 100 KB, and that it really
contains `Info.plist` and the arm64 executable. The Android job runs the unit
tests first and reads the JUnit XML, then checks the APK has `AndroidManifest.xml`
and `classes.dex`. A green tick from a build that quietly produced nothing is
the failure this repository keeps correcting for, so it is asserted.

### Installing them

- **The `.apk` installs as it is.** It is signed with the debug key Gradle
  generates automatically, so Android accepts it with no account, no settings
  change and no extra step. Sideload it, and Android will ask once whether to
  allow installing from outside the Play Store.
- **The `.ipa` is unsigned**, and it has to be. Producing one needs no Apple
  Developer account; *installing* one needs a signature. Use Sideloadly,
  AltStore or SideStore with your own Apple ID — they re-sign on the way in.

Neither is a Play Store or App Store submission, and this repository holds no
store or signing credentials.

---

## Install

Download a build from [releases](https://github.com/Itz-Npg/Cryptoric-Agent/releases).

| Platform | Asset |
|---|---|
| Windows x64 | `CryptoricAgent-<version>-x64.exe` |
| macOS (Apple silicon) | `CryptoricAgent-<version>-arm64.dmg` |
| macOS (Intel) | `CryptoricAgent-<version>.dmg` |
| Linux | `CryptoricAgent-<version>.AppImage`, `cryptoricagent_<version>_amd64.deb` |

### From source

```bash
npm install
npm run dev
```

Node ≥ 20.11.

---

## Bring your own key

Copy `.env.example` to `.env` and fill it in, or skip the file entirely and paste
keys into Settings. The `.env` route moves a key into the OS-encrypted credential
store once; a key already in the store always wins.

---

## How it's built

- Electron 33 + Vite, TypeScript, React renderer.
- **Zero runtime dependencies in the main process beyond `zod`.** The renderer
  adds `motion` and `@hugeicons/*` for the prompt bar; nothing privileged gained
  a dependency.
- **1079 tests across 50 files**, run on every push.
- CI: **Build and Release**, **CLI**, **Mobile companion**, **CodeQL** and
  **Security** — the last of which refuses a high or critical advisory in a
  dependency that ships and publishes a CycloneDX SBOM per run.

---

## Code signing

### Verifying a download

**Today there are none.** All 23 assets across the five published releases carry
zero `.asc` files, and this README will not pretend otherwise. The signing job
exists and is proven against the real installer, but it needs the
`CRYPTORIC_GPG_KEY` repository secret and a pinned fingerprint, and **fails
loudly** rather than skipping when they are absent.


A `GOOD` line is what you are looking for. `BAD` means the file does not match
what was signed — do not run it.

### Code signing policy

> **Free code signing provided by SignPath.io, certificate by SignPath Foundation**

The full policy — who may sign what, key management, team roles and the
privacy policy — is [`docs/signing/CODE_SIGNING_POLICY.md`](docs/signing/CODE_SIGNING_POLICY.md).

- **Authenticode is not in use yet.** Binaries are GPG-signed, which proves
  provenance but does **not** clear SmartScreen. Authenticode is pending
  SignPath Foundation approval; until that is granted the `.exe` carries no
  Microsoft signature and SmartScreen will still warn.
- **Contributors never receive the signing key.** There are no other
  contributors. The private key and its passphrase exist only on the
  maintainer's machine, and are not backed up anywhere.

### Attestation

This project states what it verified and what it did not. "Definition of done"
means a command that proves it, **and that command has been run**. Where a check
could not run, that is written down below rather than left to look like success.

---

## Status — honestly

**Verified, with the command that proves it:**

- Agent loop, stages, evidence gate and tool runtime — 1079 unit tests, all green.
- **Security** — symlink and junction escapes denied (a junction is used in the
  test because file symlinks need Developer Mode on Windows), session grants
  proven to expire and to refuse a tier above the one approved, credential-shaped
  environment variables proven absent from the environment a child receives, and
  the account server driven over a real socket to show a client token is refused
  a ban, an unconfigured server keeps the route shut, and the limit answers `429`
  with a `retry-after`.
- **Browser** — `npm run test:browser` → **64/64 against real Chromium**, 44 tools.
- **CLI** — builds Electron-free, offers **31 tools**, and a real run with no
  model exits **2 `BLOCKED`**, writes nothing, and explains why in both human and
  JSON output.
- **Git, tests and the web** — the git tools run against a real repository on
  disk (`git_commit` stages only the paths it was given, refuses an empty tree and
  never touches history), `run_tests` runs a real `npm test` in fixture projects
  and reports the runner's own exit code as the verdict, and `web_fetch` is driven
  against a real HTTP server on loopback — redirect chains, a 404, a declared
  charset, a byte cap, and four refusals that never become a request.
- **The capability map names real tools.** `router.ts` advertised chains built
  from eight tool ids that no builder registered, so the "canonical workflow" it
  ranked was a description of a different product. Every id is now real, and
  `tests/unit/tool-catalogue.test.ts` builds the registry both hosts build and
  fails if a chain names anything else.
- **Redaction no longer eats real data.** The heuristic that scrubs
  credential-shaped *keys* matched `author` (via `auth`) and `passed` (via
  `pass`), so a git log lost its byline and a test run lost the one boolean it
exists to report — silently, in both cases. Both patterns are anchored now.
- **iOS companion** — `swift build` + `swift test` on a GitHub macOS runner.
- **Relay** — 17/17.
- **Session economy** — the exchange rate, the price floor, the zero-coin gate
  (the stage provably never runs), the ledger, and resume-without-a-second-charge.
- **Signing** — a real sign/verify round trip on the real installer; one appended
  byte turns it `BAD`.
- **Sign-in** — the loopback listener against a real socket, the *ordering* that
  binds the port before the browser opens (a fake browser asks the port whether
  it is open; the wrong order fails the test), the session store, and the pane
  itself: `npm run test:account` renders it in all five states and checks the
  right control is drawn.
- **Hosted billing** — the app asks the server what a session costs and uses
  its numbers; an unreachable server refuses the task instead of running it
  free; a resumed task sends no request. Verified against the real handler on a
  real socket, never against a deployment.

**Not done — stated rather than implied:**

- **Neither companion has ever run on a device.** Both artifacts build and both
  are published; nothing here has installed them on a phone. The relay protocol
  underneath them is unit tested on all three sides — JavaScript, Swift and
  Kotlin — and the screens and sockets above it are not.
- **The `.apk` is debug-signed and the `.ipa` is unsigned.** Both install with
  the one step above, but neither is a store build, and a release key for each
  is the maintainer's to create.
- **The browser check does not run in CI.** It passes 64/64 on a desktop, but
  under `xvfb` the tools needing a real pointer path or a composited surface
  fail. Software-rendering switches were tried and rejected. There is no
  headless variant, because inventing one would mean testing a fake.
- **Runtime installation is Windows-only.** Every installer id is `-winget`;
  macOS and Linux correctly refuse.
- **The CLI has never run against a live model provider.** Every CLI result here
  was produced with no key set. That is the path which must refuse to claim
  success, and it does — but the model path itself is untested end to end. To
  close it: `node cli/build.mjs`, then a run with `CRYPTORIC_API_KEY`,
  `CRYPTORIC_ENDPOINT` and `CRYPTORIC_MODEL` all set, since the CLI requires all
  three. `npm run test:model` proves the shared gateway against the same provider
  first, and needs only `OPENROUTER_API_KEY`.
- **In `local` mode the coin limit is enforced on the user's machine.** The
  balance is a file, which raises the cost of cheating without making it
  impossible. `hosted` mode is the answer to that — it asks the server — but
  only if someone runs one.
- **Multi-project execution is real; the UI is not.** There is no sidebar yet to
  switch between folders.
- **The provider server has never been published.** It is tested against itself
  over loopback, not against a live deployment. `PROVIDER_TOKEN=$(openssl rand -hex
  32) node server/index.mjs` runs it for real on this machine; what is untested is
  a host other people can reach.
- **The Google handshake has not completed against Google yet — but the request
  now has.** The authorization endpoint was given the exact URL this code builds
  and accepted its shape: PKCE `S256`, `openid email profile`, offline access and
  the loopback redirect, objecting only to a deliberately fake client id. What is
  still unproven is the half after consent — Google returning a code, and the
  verifier redeeming it. `npm run test:google` runs exactly that in about a
  minute, and two of its checks only a real socket can prove: that the port was
  already answering when the browser was handed the URL, and that it is gone
  afterwards. [docs/google-sign-in.md](docs/google-sign-in.md) is the five-step
  console setup. It needs a **Desktop app** client id, which only the maintainer
  can create, and a human to consent; with none set it reports zero checks ran
  rather than passing quietly.
- **`hosted` mode is charged, but only against a server you control.** It has
  never run against a deployment: `AGENT_SERVER_URL` and `AGENT_SERVER_TOKEN`
  are yours to set, and no Vercel deployment exists. The billing path is
  verified against the real handler on a real socket. A local
  `node agentserver/src/index.mjs` with `AGENT_SERVER_TOKEN` and
  `AGENT_SERVER_ADMIN_TOKEN` set closes the loop end to end; a deployment that
  survives a restart is the part nobody has run.
- **Electron 33 is end-of-life.** Chromium 130 no longer receives security fixes,
  and this is the largest outstanding risk in the project. The upgrade is a real
  piece of work, not a version bump.
- **`npm run lint` does not pass**, so it is deliberately not a CI gate — roughly
  1.5k pre-existing errors. A gate that is red on its first run teaches people to
  ignore its output, which is worse than not having one.
- **The dependency gate covers shipped dependencies only.** `npm audit` over the
  whole tree reports high and critical advisories in the build and test toolchain
  (`electron-builder` → `tar`, `vitest` → `tinypool`). Those do not ship. They are
  reported on every run and fail nothing, and fixing them means breaking tool
  upgrades.
- **Secret scanning is a repository setting, not a file.** GitHub's secret
  scanning and push protection are both off, because enabling them is a switch in
  Settings → Code security that no commit can flip.
- **Approval prompts are domain-wide, and rate limiting is per-process.** An
  approval for one tool covers other tools in that domain for the session (within
  the tier cap), and the account server's counters live in memory — correct for
  one instance, and multiplied by N instances behind N of them.

---

## Contributing

One maintainer. Commits carry **no co-author trailers** — GitHub counts every
co-author, and this project has exactly one. Credentials are never shared: the
signing key, the Apple account, the npm token and every provider key belong to
the maintainer alone, and [`.env.example`](.env.example) says so where a secret
is expected.

---

## Privacy

[PRIVACY.md](PRIVACY.md) is the policy, written from this repository's source:
every request it describes corresponds to a `fetch` call in the tree.

There is no analytics, no telemetry, no tracking and no crash reporting in this
project — not because they are switched off, but because the dependency that
would provide them is not present. What leaves your machine is only what you
configured or asked for: a model provider you chose, an account server you
pointed the app at, a Google sign-in you clicked, a page you told the agent to
open, and an update check against GitHub.

Your files, transcripts and command output stay on your machine. They reach a
model provider only inside a request you caused, and never to the maintainer.

---

## License

[MIT](LICENSE) © 2026 Itz-Npg
