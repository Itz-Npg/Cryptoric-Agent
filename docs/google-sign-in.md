# Testing Google sign-in

This is the one part of the project that cannot be verified from the repository:
the handshake with Google needs a client id, and only the maintainer can create
one. Everything else about sign-in is unit tested — the PKCE derivation, the
constant-time `state` comparison, the attempt expiry, the ordering that binds the
port before the browser opens, the session store, and the pane that draws all
five states. What those tests cannot prove is that **Google accepts the request,
returns a code, and lets the verifier redeem it.**

This document closes that gap, in about five minutes.

---

## What the app does, so the console steps make sense

Sign-in is OAuth 2.0 Authorization Code **with PKCE**, opened in the system
browser, handed back over a loopback redirect:

- **No client secret exists in this project.** An Electron binary is not a secret
  store — anything embedded in it can be read out — so PKCE replaces the secret
  with a per-attempt verifier (`S256`). This is Google's own flow for installed
  apps. You will create a client id and a client secret in the console; the
  secret is **deliberately unused** and must not be put in `.env`.
- **The browser takes the password**, so the password is never typed into the
  app's window.
- **The redirect is `http://127.0.0.1:53123/callback`.** `127.0.0.1` is bound by
  this machine alone, so nothing off the machine can deliver a callback. The port
  is fixed so the URI can be registered.
- **`state` is compared, not trusted**, in constant time, so a redirect from
  somewhere else cannot feed us a code to redeem.

---

## 1. Create the OAuth client

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and pick or
   create a project. Creating one is free and needs no billing.
2. Create the client. The console has two current layouts for this, and both are
   the same thing:
   - **Newer:** *Google Auth Platform → Clients → Create client*
   - **Older:** *APIs & Services → Credentials → Create credentials → OAuth
     client ID*
3. If you are asked to configure the consent screen first: choose **External**,
   give it a name, and set your own address as the support email. You do **not**
   need to submit anything for verification.
4. **Add yourself as a test user** on that screen (*Audience → Test users*). This
   is the step people skip and then get `Access blocked: this app's request is
   invalid`. An app in testing mode only lets listed accounts sign in. Leave it in
   testing; do not request verification for your own use.
5. Back on the client form, set **Application type: `Desktop app`**. This choice
   is load-bearing — a *Web application* client will be rejected with
   `redirect_uri_mismatch`.
6. Name it anything (`Cryptoric Agent desktop`) and click **Create**.
7. On the redirect URI: a **Desktop app** client uses a loopback redirect, and
   Google does not take the port into account for it, so registering the URI is
   not required. If the form does show an *Authorized redirect URIs* field, add
   exactly:

   ```
   http://127.0.0.1:53123/callback
   ```

   If the form does not show that field, that is expected for this client type —
   not a mistake, and not something to work around by choosing a web client.

8. Copy the **Client ID**. It ends in `.apps.googleusercontent.com`. Ignore the
   client secret entirely.

---

## 2. Give it to the app

Open [`.env.example`](../.env.example), copy it to `.env` in the repository root
if you have not already, and set:

```
GOOGLE_CLIENT_ID=1234567890-xxxxxxxxxxxxxxxx.apps.googleusercontent.com
```

`.env` is gitignored. The app reads it at boot from the repository root or from
its own user-data directory, so **restart the app after changing it** — the id is
read once, and the Account pane will keep saying sign-in is not configured until
you do.

---

## 3. Verify it, from a terminal

```
npm run test:google
```

This runs the real handshake through the same `startSignIn` sequence the app
uses: the real loopback listener on port 53123, the real authorization endpoint,
the real code exchange, and the real userinfo call. It opens your browser; sign
in to whichever account you added as a test user.

What it prints when it works:

```
[PASS] the URL sent to Google is the authorization endpoint with S256 PKCE and offline access
[PASS] port 53123 was already answering when the browser was opened
[PASS] Google exchanged the code for a real access token (… chars)
[PASS] userinfo returned a sub, so an account can be keyed: you@example.com
[PASS] sub maps to a well-formed account id: acct_…
[PASS] a refresh token came back, so the person is not asked to sign in again
[PASS] port 53123 closed after one callback, so a reloaded tab cannot deliver a second code
[PASS] Google refused to redeem the code a second time: …
[PASS] the local attempt was consumed, so a replayed callback has nothing to match state against
```

That is nine lines on a first sign-in, and three of them cannot be proven any
other way. **port 53123 was already answering** is measured from inside the
callback that opens the browser — the unit test for that ordering uses a fake
browser, so this is the first time it is measured against a real socket. **port
53123 closed after one callback** is what stops a reloaded tab from delivering a
second code. And **Google refused to redeem the code a second time** is Google
answering, not us: the spent code is presented again with the verifier that
legitimately redeemed it, and Google must refuse. If a code were reusable, one
observed in a browser history or a proxy log would be a durable credential.

The check holds nothing afterwards: the access token and any refresh token stay
in the process's memory and are dropped when it exits. It deliberately does not
write to the OS credential store.

With no `GOOGLE_CLIENT_ID` it prints `[SKIP]` and exits 0, saying plainly that
**zero checks ran**. An absent credential is a missing input, not a pass.

---

## 4. Verify it, in the app

```
npm run dev
```

Open the **Account** pane and press **Sign in**. Your browser opens Google's
consent screen; after you approve, the tab says *You're signed in* and the pane
shows your name and email with the loopback address it used.

If your browser refuses to open `127.0.0.1` — some corporate networks do — the
pane has a paste box: copy the full redirect URL out of the address bar and paste
it there. That path is real, not a fallback in name only.

---

## When it fails

| What you see | What it means |
|---|---|
| `Access blocked: this app's request is invalid` | Your account is not on the consent screen's test-user list. Add it. |
| `Error 401: invalid_client` / *OAuth client was not found* | The id in `.env` is wrong or truncated, or the app was not restarted after setting it. |
| `redirect_uri_mismatch` | The client is not a **Desktop app** client. Create one of that type — do not try to fix it by registering a URI on a web client. |
| `Sign-in timed out. Try again.` | The browser never reached `127.0.0.1:53123`. Check the URL in the address bar is the loopback one, and that a firewall is not blocking it. |
| `Could not listen for the sign-in redirect` | Something already holds port 53123 — most likely the app, or another run of this check. |
| No refresh token, and you must sign in each time | Expected after a previous consent. To force a new one, remove the app's access at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) and sign in again. |

---

## After it passes

Once this has run, the claim in [README.md](../README.md) that the Google
handshake has never run against Google is no longer true, and that bullet should
say what was verified and when. Do not leave a limitation in place that the
project has moved past — the whole point of the list is that it is accurate.
