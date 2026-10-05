# cryptoric

Cryptoric Chan from your terminal — the same staged agent pipeline that runs
inside the Cryptoric Agent desktop app, headless.

```bash
cryptoric                       # interactive: prompt box, type a task, get a result
cryptoric run "add a README describing this project"   # one shot, for scripts
```

Inside a session: `/tools` lists what the binary can actually call, `/doctor`
reports configuration, `/cwd` prints the workspace root, `/exit` leaves.

## What this is

![A real cryptoric session: the wordmark, a task typed into the prompt box, and a BLOCKED verdict because no model provider is configured](docs/cli-session.svg)

<sub>A real capture, produced by `node scripts/capture-cli-svg.mjs` driving this
code with no model provider configured. It is what the CLI actually printed.</sub>

The desktop app and this CLI are two **composition roots** over one
implementation. `AgentRuntime`, the stage pipeline, `ToolRuntime`,
`PermissionPolicy`, every tool definition, the skills registry, the model gateway
and the system prompts are all shared source files. Only the edges differ:

| | Desktop app | CLI |
|---|---|---|
| State | OS `userDataDir` | `CRYPTORIC_HOME`, default `~/.cryptoric` |
| API key | OS-encrypted keychain | `CRYPTORIC_API_KEY` environment variable |
| Approvals | an on-screen queue | stdin, or `--yes` / `--deny` |
| Browser | `WebContentsView` inside a window | **not available** |
| Progress | React UI | stderr text, `--json` for machines |

There is no second implementation of the agent to drift. If the pipeline
changes in `src/main/services/agent/`, the CLI changes with it.

## Install

```bash
npm install -g cryptoric
```

Or run it without installing:

```bash
npx cryptoric run "..."
```

## Commands

```
cryptoric run "<task>"        Run the agent pipeline on a task
cryptoric tools               List the tools this CLI actually has
cryptoric doctor              Report environment and configuration
cryptoric help                Full usage
```

### Run options

| Flag | Meaning |
|---|---|
| `--cwd <dir>` | Project root to work in. Default: current directory |
| `--yes` | Pre-approve gated operations, **including destructive ones** |
| `--deny` | Refuse gated operations; gated work reports `BLOCKED` |
| `--json` | Machine-readable result on stdout, progress on stderr |
| `--provider <name>` | Model provider override |
| `--endpoint <url>` | Model endpoint override |
| `--model <id>` | Model id override |
| `--timeout <seconds>` | Wall-clock cap. Default 1800 |

## Exit codes

The pipeline distinguishes five outcomes, so the exit code does too. Collapsing
them to `0` and `1` would throw away the distinction the desktop app works to
preserve.

| Code | Verdict | Meaning |
|---|---|---|
| 0 | `COMPLETED` | The work was done and change was observed |
| 1 | `FAILED` | The run happened and did not succeed |
| 2 | `BLOCKED` | It could not proceed without a decision |
| 3 | `CANCELLED` | Interrupted |
| 4 | `PARTIAL` | Work done, verification unfinished |
| 64 | — | The command line was wrong |

A run with **no observed file change is never `COMPLETED`.** If you ask for an
edit and no bytes change, you get `2 BLOCKED` and a reason, not a green tick.

## Configuration

Without these three variables the CLI still runs, and runs the deterministic
stages (project detection, environment probing, skill routing). It will tell you
it is doing so rather than pretending an agent is at work.

| Variable | Purpose |
|---|---|
| `CRYPTORIC_API_KEY` | API key for the provider |
| `CRYPTORIC_PROVIDER` | Provider name (default `openrouter`) |
| `CRYPTORIC_ENDPOINT` | Provider endpoint URL |
| `CRYPTORIC_MODEL` | Model id |
| `CRYPTORIC_HOME` | State directory |
| `CRYPTORIC_DAILY_BUDGET_COINS` | Daily spend ceiling |

The API key is read from the environment and **never written to disk** by this
process. There is no keychain here, and the CLI does not create one.

## Approvals

Gated operations prompt on stdin. When stdin is **not** a terminal the CLI
refuses and says so — an absent human is not consent. In CI, pass `--deny` to
get deterministic refusals or `--yes` to pre-approve.

## What this cannot do

Stated plainly, because the alternative is finding out later:

- **No browser.** Browser tools are backed by `WebContentsView`, which needs a
  window. They are not registered at all, so `cryptoric tools` does not list
  them. Use the desktop app for anything that needs a real browser.
- **No interactive terminal UI.** Long-running commands run as managed
  processes; their output is written to stderr as it arrives.
- **No App Store / TestFlight distribution.** The iOS companion builds and
  tests in CI; shipping it needs an Apple Developer account.

## Developing

```bash
npm run typecheck:node   # from the repo root
node cli/build.mjs       # bundle to cli/dist/index.js
```

The build fails if an Electron module ever reaches the CLI entry point, and
`tests/unit/cli-surface.test.ts` fails if the shared agent layer imports Electron
or if the system prompts are duplicated. Those two properties are what make this
a second surface instead of a fork.

## Publishing

```bash
npm publish
```

Run from this directory. `prepack` builds the bundle, so the published tarball
is runnable without a separate build step.