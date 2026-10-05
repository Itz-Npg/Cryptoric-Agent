# `agentserver` — accounts, coins, models, integrity

The account server for Cryptoric Agent. It exists so a coin balance can **outlive
the app**: uninstall, reinstall, sign in on a different machine, and the balance
is the same one, because it was never on the machine to begin with.

Runs on anything that speaks HTTP — a VPS, a container, or
[Vercel](https://vercel.com). **Zero runtime dependencies.**

```bash
AGENT_SERVER_TOKEN=$(npm run --silent token) \
AGENT_SERVER_PORT=8789 \
MODEL_CATALOGUE_PATH=./catalogue.json \
node src/index.mjs
```

It refuses to start without a token. An account server with no authentication is
an open proxy that hands out coins, and starting one "just to look" is exactly
how that happens.

---

## Two modes, chosen in `.env`

| `CRYPTORIC_MODE` | Where coins live | Survives uninstall |
|---|---|---|
| `local` (default) | A ledger on this machine | ❌ |
| `hosted` | This server | ✅ |

`AGENT_SERVER_URL` must agree with the mode. Setting one without the other is an
**error, not a fallback** — a build cannot be half-hosted, because a silent
fallback to local leaves you believing your balance is synced when it is sitting
in a file.

---

## Endpoints

| Method | Path | What it does |
|---|---|---|
| `GET` | `/health` | Liveness. Open, so a host does not need a token to probe it. |
| `GET` | `/v1/models` | The catalogue this server publishes. |
| `POST` | `/v1/accounts` | Create or fetch an account. Returns the balance. |
| `GET` | `/v1/balance?accountId=…` | Today's remaining coins. |
| `POST` | `/v1/charge` | Buy a session. **Idempotent** on `grantId`. |
| `POST` | `/v1/integrity` | Record what the watcher saw. Bans the account. |

All except `/health` need `Authorization: Bearer $AGENT_SERVER_TOKEN`.

### The client side of this

The Electron app ships a client for exactly these endpoints
(`src/main/services/server/client.ts`) and a billing gate that uses nothing
else in `hosted` mode (`src/main/services/session/charge.ts`):

- a task's price comes from `POST /v1/charge`, and the grant is built from the
  server's `coins` and `minutes` — the app never computes its own;
- an unreachable server **refuses the task**. It does not fall back to the local
  ledger, because unplugging the network would otherwise be a way to run free;
- nobody signed in means no task, with the server's own wording;
- a resumed task sends no request at all — it continues the grant it already has.

`tests/unit/hosted-session.test.ts` drives all four against this real handler on
a real socket.

```bash
curl -X POST http://127.0.0.1:8789/v1/accounts \
  -H "authorization: Bearer $AGENT_SERVER_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"accountId":"acct_00000001"}'
# {"accountId":"acct_00000001","balance":25,"dailyCoins":20}

curl -X POST http://127.0.0.1:8789/v1/charge \
  -H "authorization: Bearer $AGENT_SERVER_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"accountId":"acct_00000001","grantId":"grant-e2e-1","modelId":"fixture-model"}'
# {"coins":5,"minutes":30,"balance":20,"duplicate":false}
```

---

## The rules, and why each one exists

**The client cannot state its own price.** The tier comes from the catalogue,
looked up server-side by `modelId`. A client that could post `coins: 1` would
not be on a balance system; it would be a suggestion.

**Charging is idempotent on `grantId`.** A client that times out and retries is
ordinary, not an attack. Without this, every retry silently costs the user again.

**The balance is derived, never stored.** It is the daily allowance plus the
signup grant, minus every charge in the ledger. A number in a document is a
number someone can edit; a ledger can be audited, and editing one row shows up
in the sum.

**A ban holds on every endpoint.** A ban that only bites on `/v1/charge` is
side-stepped by asking `/v1/balance` instead.

**Body size is capped.** One request cannot exhaust the process.

**A malformed catalogue is an empty one, loudly.** Falling back to a default list
would publish prices nobody chose.

---

## Storage

`MONGODB_URI` selects MongoDB; without it the balance is held in memory, which is
fine for one process and **wrong** for anything scaled — a serverless function can
be recycled between requests, and a balance in memory does not survive that. The
Vercel entry point warns on startup when it is unset.

MongoDB is reached over the **REST Data API** rather than the driver, so this
server keeps zero dependencies — the thing holding balances should not carry a
dependency tree. Atlas exposes that API directly:

```bash
MONGODB_URI='<your data-api key>'
MONGODB_REGION=us-east-1      # the Data API is region-scoped
MONGODB_DATABASE=cryptoric
```

Self-hosted Mongo has no Data API; point `MONGODB_URI` at an https gateway and
it is used as-is.

---

## Deploying to Vercel

`api/index.mjs` is the entry point Vercel looks for, and it is the **same
handler** `src/index.mjs` mounts on `node:http` — not a second implementation.
Two implementations is how the deployed server and the tested server stop being
the same program.

Set these as project environment variables:

```
AGENT_SERVER_TOKEN=<32+ random bytes>
MONGODB_URI=<data api key>
MONGODB_REGION=us-east-1
MODEL_CATALOGUE_PATH=/tmp/catalogue.json   # optional; empty catalogue = all BYOK rate
```

The catalogue path must be readable in the deployed environment; for a static
list, commit it and point at the file in your repo.

---

## What this server does not do

- **It does not detect cheating.** It records what a client's watcher reports and
  applies the ban. Detection lives on the client, and a client that has been
  patched can lie — which is why the ban is applied here rather than there.
- **It has never been deployed.** Everything here was verified against the real
  handler over a real socket and against the real `node` entry point on loopback.
  Nothing has run on Vercel.
- **The Mongo adapter has never spoken to MongoDB.** Its URL building, request
  shapes, `_id` mapping and error reporting are tested against a stubbed Data
  API; the wire format itself is assumed to match Atlas's. Point it at a real
  cluster before trusting a balance with it.
- **It has no accounts, no passwords and no sessions.** `accountId` is an opaque
  id, and the app now mints it from a Google sign-in (`acct_` plus 32 hex
  characters) rather than trusting anything the request body says. What the
  server still does not do is *authenticate* that id: it stores what it is
  given. Anyone who can reach it with the token can bill any account id.