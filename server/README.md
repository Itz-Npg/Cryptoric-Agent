# Cryptoric provider server

Publish your own models to every Cryptoric install that points at this server.
No dependencies — `node:http` only.

```bash
PROVIDER_TOKEN=$(openssl rand -hex 32) node server/index.mjs
```

Then in the app: **Settings → Advanced → provider server URL**, enable it, and
put the same token in the credential store.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Liveness and a model count. No auth. |
| `GET` | `/v1/models` | The catalogue. Requires the token. |
| `POST` | `/v1/chat/completions` | Proxied upstream. Requires the token. |

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `PROVIDER_TOKEN` | **yes** | Bearer token clients must present |
| `PORT` | no | Defaults to `8788` |
| `UPSTREAM_BASE_URL` | no | Enables proxying. Omit for catalogue-only |
| `UPSTREAM_API_KEY` | no | Your upstream key. **Stays on this server** |
| `CATALOGUE_PATH` | no | JSON file to publish instead of the built-in list |
| `ALLOW_ORIGIN` | no | CORS origin. Off by default |

## Your own catalogue

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "models": [
    {
      "id": "cryptoric-mini",
      "label": "Cryptoric Mini",
      "description": "Fast and cheap.",
      "contextWindow": 128000,
      "byok": false
    }
  ]
}
```

```bash
CATALOGUE_PATH=./catalogue.json PROVIDER_TOKEN=... node server/index.mjs
```

A model with no `id` is dropped rather than shown. A `contextWindow` that is not
a positive number becomes `0` instead of `NaN`, because a nonsense context
window silently truncates every request made with that model.

## Security

These are deliberate, and each one is enforced in code rather than in a comment:

- **The token is mandatory.** With `PROVIDER_TOKEN` unset the server exits 1
  rather than serving an open catalogue and an open proxy to your upstream key.
- **Tokens are compared in constant time.** A check that returns early on the
  first differing byte leaks the token one character at a time to anyone who can
  measure.
- **The upstream key never reaches a client.** Clients get a catalogue and a
  token for this server. When proxying, the upstream credential stays here.
- **Upstream errors are not echoed.** The message can contain the upstream URL.
  The client gets a status code and nothing else.
- **Request bodies are capped** at 2 MB, so one request cannot exhaust memory.
- **CORS is off by default.**

The client side refuses to send the token over plain `http:` to a
non-loopback host. There is an explicit per-installation opt-out
(`advanced.providerServerAllowInsecure`) for a trusted LAN or a tunnel, because
refusing outright would make that setup impossible — but the default is the safe
one.

## Verifying it

```bash
npm run test:provider
```

Those tests start **this** server on an ephemeral port and fetch it over
loopback, covering the valid token, a wrong token, a missing token, the
catalogue-path form, and an unreachable server. A hand-written fake would only
prove the client agrees with itself.
