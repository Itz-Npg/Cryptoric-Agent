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
| Integrated browser | 43 tools, `npm run test:browser` → 64/64 against real Chromium |
| Design Mode (`browser_inspect_element`) | Markup + computed style + reusable selector in one call; 5 new live checks |
| Honest browser verification in the pipeline | 5 distinct outcomes; a build can no longer deny a browser it has |

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
| `mobile/relay` — Node bridge the desktop app serves | Open |
| `mobile/ios/CryptoricKit` — models, relay client, views | Open |
| Android companion | Open |
| Pairing / QR handshake | Open |

### CLI

`cryptoric run "task"` — the same pipeline, headless.

This is the unlock for everything else. Worktrees, terminals and CI runners can
only be automated once there is something to invoke without the GUI. The hard
part is not argument parsing: it is that the agent currently assumes an Electron
main process with a window and real browser tabs, so the core has to be
extractable before a CLI can drive it honestly.

Scope: extract the pipeline from the GUI, expose it, publish as an npm package.
You run `npm publish` with your own token — **never send publish credentials to
me.**

### Worktree isolation

One `git worktree` per agent task, so parallel runs cannot collide or dirty the
main checkout.

This changes *where the agent writes files*, so it reshapes the core. Doing it
before the CLI exists means doing it twice.

### Desktop work

| Feature | Notes |
|---|---|
| Quick open | Command palette over files, tools, commands. Self-contained. |
| Notifications + unread | Electron native notifications; real value once agents run long. |
| Multiple terminals | Working terminal panes. **Not** Ghostty-class WebGL rendering — that is a different product. |

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