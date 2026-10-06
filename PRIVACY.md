# Privacy Policy

**Cryptoric Agent** — an AI-native development environment: a desktop app, a
CLI, and a mobile companion that all run the same agent.

This policy describes what the software does with your data. It is written from
the source code in this repository, not from a template: every network request
listed below corresponds to a `fetch` call that exists in the tree, and every
local file listed is one the app actually writes.

- **Version covered:** 0.1.5
- **Last reviewed:** 2026-10-06
- **Applies to:** the desktop app, the `cryptoric` CLI, and the `mobile/relay`
  Node server, unless a section below says otherwise.

---

## The short version

There is **no analytics, no telemetry, no tracking, no advertising SDK and no
crash reporting** anywhere in this project. The app does not have a code path
that collects usage data, because the dependency that would provide one is not
in the tree.

What leaves your machine is only what you explicitly configured or asked for:
a model provider you chose, an account server you pointed the app at, a Google
sign-in you clicked, a page you told the agent to open, and an update check
against GitHub. The default `local` mode sends model requests and nothing else.

Your project files, conversations and command output stay on your machine. The
agent reads and writes them locally; they are sent to a model provider **only
as part of a model request you caused**, and never to the project maintainer.

---

## Who maintains this project

**Itz-Npg** is the sole maintainer and the only person with commit access to
this repository. There is no company, no organisation, no team, and no other
contributor. Every credential in this project — the release signing key, the
Apple account, the npm token, provider API keys — belongs to that one person
personally, and is not shared with anyone else.

Maintainer contact: <https://github.com/Itz-Npg>

---

## What is sent over the network

Every item in this section is **opt-in**. None of it happens until you supply a
value, click a button, or start a process yourself.

### 1. Model provider requests (the main one)

When the agent runs a task, it sends a request to the model provider configured
in Settings. This is inherent to what the app does — a model cannot see your
code without being sent it.

**Sent:** your task description, the conversation, system instructions, the
contents of files the agent read, the output of commands the agent ran, and
relevant page content when the agent uses the browser.

**Also sent:** your API key, in an `Authorization` header, to that provider only.

**Where it goes:** whichever OpenAI-compatible endpoint you configured. This may
be a hosted provider (OpenRouter, APINEX, OpenAI, or another), a server running
on your own machine (Ollama, LM Studio, llama.cpp, vLLM), or a gateway you
control. The app ships with no default provider account.

**Governing rule:** the provider you pick is the only party that receives this
data besides you. If you want nothing to leave the machine at all, point the
app at a local model server. If you run your own proxy with
[`server/index.mjs`](server/index.mjs), your upstream provider key never reaches
a client.

**To disable:** remove the provider in Settings, or leave the app with no
provider configured. With no provider the agent refuses to run and reports that
it is blocked.

### 2. Google sign-in (only if you click Sign in)

Only active if a `GOOGLE_CLIENT_ID` is configured on the build *and* you start
sign-in.

| Destination | Why |
| --- | --- |
| `accounts.google.com` | You authenticate in your own browser, not in this app |
| `oauth2.googleapis.com` | Authorization code is exchanged for a token |
| `openidconnect.googleapis.com` | Your Google id, email, name and profile picture are read |

**Scopes requested:** `openid`, `email`, `profile` — the minimum needed to know
who you are. No client secret ships with the app; the flow uses PKCE.

**Stored locally:** your access token and refresh token go into the operating
system credential store, not a settings file.

**To disable:** never click Sign in, or sign out from the Account pane.

### 3. Account server (only in `hosted` mode)

Only active when the app is started with `CRYPTORIC_MODE=hosted` **and**
`AGENT_SERVER_URL` is set. The default is `local` mode, which contacts no
account server at all.

**Sent:** your pseudonymous account id, an optional display name, the model id
you selected, a task/grant id, and a bearer token. The account id is a hash
derived from your Google id — not your email address.

**Never sent:** your prompts, your files, your command output, or your API keys.

**To disable:** use `local` mode, or omit `AGENT_SERVER_URL`. Setting one
without the other is treated as a configuration error rather than a silent
fallback.

### 4. Mobile relay (only if you run it)

`mobile/relay` is a zero-dependency Node server **you** start. It exists to
bridge a phone to your agent. It sends and receives whatever commands your phone
issues over its local WebSocket. It is not started, contacted, or operated by
the project.

**To disable:** do not run it. Stop the process.

### 5. Update checks

The app periodically asks GitHub whether a newer release exists, via
`electron-updater`.

**Sent:** a normal HTTPS request to `github.com`. That necessarily reveals your
IP address and user agent to GitHub. No project, file, or usage data is
included.

Downloads do not start automatically — the app checks, then asks.

**To disable:** the Settings pane exposes an update channel; choosing a channel
that does not check, or running a development build (which has no feed at all),
stops it.

### 6. Pages the agent opens in its browser

When you ask the agent to visit a URL, your machine makes a request to that
site. Your IP address and the requested URL are visible to that site, exactly as
they would be in any browser.

**Stored locally:** each browser tab keeps its own isolated Chromium session —
its own cookies, cache and profile directory — under the app's user data
directory. A temporary tab deletes its cookies, cache and profile directory when
closed. Closing the app does not delete persistent tabs' sessions.

**To disable:** close browser tabs; do not ask the agent to navigate.

### 7. Connectors (only if you configure one)

You may connect third-party services such as issue trackers or Sentry by
supplying your own API token. The token is sent to that service in an
`Authorization` header, and is stored in the operating system credential store.

**To disable:** remove the connector.

### 8. Runtime installer (only on Windows, only on request)

If you ask the app to install a missing runtime, it invokes `winget` with a
fixed package identifier, and the download is served by Microsoft's package
repository. macOS and Linux correctly refuse.

**To disable:** decline the installation prompt.

---

## What is stored on your machine

### Inside your project

`<your-project>/.cryptoricagent/` holds a project manifest and the conversation
transcript. **The transcript contains what the agent read and wrote**,
including the full output of commands it ran — so it can contain file contents,
command output and anything those contained. It is written to disk in plain
text.

The directory writes a `.gitignore` containing `*` into your project so it does
not appear as untracked noise.

You can delete it at any time. Deleting it deletes the project's history.

### In the app's user data directory

| Path | Contents |
| --- | --- |
| `state.json` | Settings, theme, recent project list |
| `credentials.json` | Provider keys, account server token, OAuth tokens, connector tokens |
| `browser/` | One isolated browser session per tab |
| `downloads/` | Files the agent downloaded in the browser |
| `tools/cryptoric-tools/` | Runtimes the app manages |
| `tmp/` | Scratch space |

`credentials.json` is encrypted with the operating system's credential store
(Electron `safeStorage`). **If the operating system offers no encryption
backend, the app refuses to persist a secret rather than writing it in plain
text**, and tells you it is keeping the value in memory only.

Nothing in this directory is uploaded automatically. There is no upload path.

---

## How secrets are handled

- API keys are written to the operating system credential store, never to a
  settings file, never to a project file, and never sent back to the renderer
  process.
- Tool arguments, command output, log lines and error messages pass through a
  redaction layer that strips values shaped like credentials — API keys, bearer
  tokens, private key blocks, credentials embedded in URLs.
- Every tool call is recorded in an audit trail with its arguments scrubbed.

This reduces accidental leakage. It is not a guarantee: a redaction layer is a
filter, and content that does not look like a credential will pass through it.

---

## Children

This software is a developer tool intended for adults. It is not directed at
children, and it does not knowingly collect information from them.

---

## Your rights and choices

Depending on where you live, you may have rights to access, correct, delete, or
port your personal data, and to object to its processing.

In practice, most data never reaches us: it stays on your machine or goes
directly to a provider you chose. What you can control:

- **Delete everything local** by uninstalling the app and removing its user data
  directory, and by deleting the `.cryptoricagent` folder in any project.
- **Withdraw sign-in** from the Account pane.
- **Stop all model traffic** by unconfiguring the provider, or by pointing the
  app at a local model server.
- **Stop account-server traffic** by using `local` mode.

For anything held by the account server — your account id and balance — contact
the maintainer at the address above, or the operator of the account server if
you configured one yourself.

---

## Changes to this policy

Any change to this policy is a commit to this repository and is therefore
visible in its history. If the software's behaviour changes, this document
changes with it.

---

## License

Cryptoric Agent is MIT licensed. The license covers the software; it does not
limit your data rights, which are described above.