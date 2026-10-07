# Roadmap

What Cryptoric Agent is building next, and — more importantly — what is real
today versus still open. Nothing below is marked done on intent.

This file replaces the deleted `work.md` / `todo.md`. Those tracked
*verification*; this tracks *direction*. Verified claims live in the README and
in `docs/signing/AUDIT.md`.

## Done and verified

| Thing | Proof |
|---|---|
| Release signing (OpenPGP) | Sign + verify round trip on the real 188 MB installer; public key committed |
| Integrated browser | 44 tools, `npm run test:browser` → 64/64 against real Chromium |
| Design Mode (`browser_inspect_element`) | Markup + computed style + reusable selector in one call; 5 new live checks |
| Honest browser verification in the pipeline | 5 distinct outcomes; a build can no longer deny a browser it has |
| **iOS companion** | `swift build` + `swift test` green on macos-15; the job fails unless `Executed N tests` appears with N ≥ 10 |
| **`cryptoric` CLI** | 31 tools, one 475 KB file, no Electron; a real task run returns exit 2 `BLOCKED` and writes nothing |
| **Agent capabilities** | Git (status/diff/log/commit), `run_tests`, `web_fetch` and `analyze_project` registered in **both** hosts — a git tool runs against a real repository, a test run returns the runner's exit code, and a fetch is driven against a real server on loopback |
| **Environment PATH** | Machine PATH read as `REG_EXPAND_SZ` and expanded before a child gets it; `npm run <script>` previously died on `ENOENT spawn %SystemRoot%\system32\cmd.exe` |
| **Transcript paths** | Resolved absolutely, including with no project open — `join('', 'conversation.json')` used to write a transcript into the process's working directory and read it back as history |
| **`.cryptoricagent/` per project** | Created on open, stable id, history in the project folder *and* the app folder; 8/8 end-to-end checks across two projects and three separate processes |
| **Multi-project parallel execution** | 3 projects observed running concurrently; tasks inside one project still serialised, measured inside the stage, not by wall clock |
| **Self-hosted model provider** | `server/index.mjs` serves a catalogue; 17 tests round-trip against the real server, wrong and missing tokens rejected |

### The CLI shipped, and it did not need a rewrite

The plan said the agent "currently assumes an Electron main process with a window
and real browser tabs, so the core has to be extractable before a CLI can drive
it honestly." **That was wrong, and the reason it is worth recording here:** the
assumption had never been checked. Of 1,593 lines in `main/index.ts`, the agent,
tool, skill, permission and environment layers never imported Electron at all —
only 5 files in `src/main` ever did, and none of them were the agent.

So the CLI is not a port. It is a second *composition root* over the same
implementation:

| | Desktop app | `cryptoric` |
|---|---|---|
| State | OS `userDataDir` | `CRYPTORIC_HOME`, default `~/.cryptoric` |
| API key | OS-encrypted keychain | `CRYPTORIC_API_KEY`, never written to disk |
| Approvals | on-screen queue | stdin; absent TTY **refuses** |
| Browser | `WebContentsView` | not registered, not stubbed |

What had to change: `chanSystemPrompt` / `planSystemPrompt` were private
functions inside `main/index.ts`, so they moved to
`src/main/services/agent/prompts.ts`. Two copies of an agent's instructions
drift silently, because nothing fails when one is edited.

Two properties are now asserted by tests rather than by memory: the shared layer
imports no Electron, and the prompts are defined once.

**Not verified:** a run against a live model provider. Everything above was
proven with no API key configured, which is exactly the path that must refuse to
claim success — and it did, exit 2, zero files written.

## In progress

### Mobile companion

A phone app that shows what every agent is doing and lets you steer it.

**What CI can verify:** Swift builds and unit tests on a GitHub macOS runner;
a full Android APK build; the relay's protocol tests.

**What it cannot verify, and why:**

- App Store / TestFlight submission, device provisioning and APNs push all
  require a paid Apple Developer Program membership and certificates only the
  account holder can create. The app will be written and compiled, not
  distributed.
- A device install. Nothing here can put an app on your phone.

So the deliverable is: **source that compiles and passes tests on CI**, plus a
built artifact you can install yourself if you hold the accounts.

| Piece | State |
|---|---|
| `mobile/relay` — Node bridge the desktop app serves | 17/17 protocol tests green |
| `mobile/ios/CryptoricKit` — models, relay client, views | Green on macos-15 |
| Android companion | Open |
| Pairing / QR handshake | Open |

### CLI — shipped

See "Done and verified" above. Remaining: `npm publish`, which you run with your
own token. **Never send publish credentials to me.**

### Worktree isolation

One `git worktree` per agent task, so parallel runs cannot collide or dirty the
main checkout.

**The prerequisite is now done.** Multi-project execution ships, and tasks in
separate projects run genuinely concurrently while tasks in the same project
still serialise. Worktrees are the remaining half: they change *where* the agent
writes, which is a different question from *when*.

### Desktop work

| Feature | Notes |
|---|---|
| Quick open | Command palette over files, tools, commands. Self-contained. |
| Notifications + unread | Electron native notifications; real value once agents run long. |
| Multiple terminals | Working terminal panes. **Not** Ghostty-class WebGL rendering — that is a different product. Now unblocked: `TerminalSessionManager` is already headless and drives `cryptoric` today. |
| Any CLI agent | Orca's actual insight: *if it runs in a terminal, it runs in Orca.* Cryptoric already runs arbitrary commands via `run_command`, so this is a wrapper, not a reimplementation. |

## Deliberately not copying from the reference

Orca is a company that ships daily. These are out of scope for this product and
would be dishonest to list as planned:

- Ghostty-class WebGL terminal rendering
- SSH remote runtime with port forwarding
- Linear / GitHub native project browsing
- Claude/Codex account switching and quota display — Cryptoric brings its own
  providers and does not proxy other agents
- A cloud agent fleet

## Definition of done

A feature is done when there is a command that proves it, and that command has
been run. Not when the code exists.