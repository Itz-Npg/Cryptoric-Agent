/**
 * A deliberately imperfect dev server for the live browser check.
 *
 * The point is that every defect the browser tools claim to detect is actually
 * present here: a console error with a stack, a 404 from an API call, a form
 * that validates client-side, a counter that only moves on a real click, an
 * element that appears late, and a second page to navigate to.
 *
 * Nothing here is stubbed in the tools under test — the tools talk to this
 * server over real HTTP through real Chromium.
 */

import { createServer, type Server } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AddressInfo } from 'node:net'

const PAGE_ONE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Cryptoric Test App — Sign up</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 40px; color: #101014; }
  .counter { font-size: 2rem; }
  label { display: block; margin: 12px 0 4px; }
  input, select { padding: 8px; width: 280px; }
  button { padding: 10px 18px; margin-right: 8px; }
  .error { color: #b00020; }
</style>
</head>
<body>
  <h1>Sign up</h1>
  <p id="intro">Create an account to continue.</p>

  <p class="counter">Clicks: <span id="count">0</span></p>
  <button id="counter" type="button">Add</button>

  <form id="signup" novalidate>
    <label for="email">Email</label>
    <input id="email" name="email" type="email" required />

    <label for="password">Password</label>
    <input id="password" name="password" type="password" minlength="8" required />

    <label for="plan">Plan</label>
    <select id="plan" name="plan">
      <option value="free">Free</option>
      <option value="pro">Pro</option>
      <option value="team">Team</option>
    </select>

    <label for="avatar">Avatar</label>
    <input id="avatar" name="avatar" type="file" accept="image/*" multiple />

    <p><button id="submit" type="submit">Create account</button></p>
    <p id="form-error" class="error" hidden></p>
  </form>

  <p><a id="second-link" href="__SECOND__">Read the docs</a></p>
  <div id="late" hidden>Late content appeared</div>
  <img id="logo" src="__BROKEN_IMAGE__" alt="Cryptoric logo" width="64" height="64">

  <script>
    // A genuine console error, on purpose: the console tool must surface it.
    console.error('cryptoric-fixture: deliberate boot failure', { code: 'E_FIXTURE' });

    // A request that fails: the network tools must see a 4xx that console
    // never reports. Over HTTP this is a real 404 from the fixture server.
    fetch('__MISSING_API__').catch(function () {});

    var clicks = 0;
    document.getElementById('counter').addEventListener('click', function () {
      clicks += 1;
      document.getElementById('count').textContent = String(clicks);
    });

    document.getElementById('signup').addEventListener('submit', function (event) {
      event.preventDefault();
      var email = document.getElementById('email');
      var password = document.getElementById('password');
      var error = document.getElementById('form-error');
      if (!email.value.includes('@')) {
        error.textContent = 'Enter a valid email address.';
        error.hidden = false;
        return;
      }
      if (password.value.length < 8) {
        error.textContent = 'Password must be at least 8 characters.';
        error.hidden = false;
        return;
      }
      error.hidden = true;
      document.getElementById('intro').textContent = 'Account ready for ' + email.value;
    });

    // Appears only after the agent waits for it: browser_wait must be real.
    setTimeout(function () {
      document.getElementById('late').hidden = false;
    }, 900);
  </script>
</body>
</html>`

const PAGE_TWO = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Cryptoric Test App — Docs</title></head>
<body><h1>Documentation</h1><p>The second page, reached by a real link click.</p>
<p><a id="home-link" href="__HOME__">Back to sign up</a></p></body></html>`

export interface Fixture {
  server: Server
  port: number
  url: string
  /**
   * The same page, written to disk and loaded over `file:`.
   *
   * Some Windows builds of Chromium do not deliver protocol-synthesised input to
   * renderers of *network* origins at all, while the identical code works for a
   * non-network document. Keeping both forms lets the interaction checks be
   * proved for real on a machine where HTTP input is broken, instead of being
   * misreported as a product failure.
   */
  fileUrl: string
  /** False when served from `file:`, where cross-page navigation differs. */
  multiPage: boolean
  requestLog: { method: string; url: string; status: number }[]
  close(): Promise<void>
}

/** Start the fixture on an ephemeral port so parallel runs cannot collide. */
export function startFixture(workDir?: string): Promise<Fixture> {
  const requestLog: { method: string; url: string; status: number }[] = []

  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    const send = (status: number, type: string, body: string): void => {
      requestLog.push({ method: req.method ?? 'GET', url, status })
      res.writeHead(status, { 'content-type': type })
      res.end(body)
    }

    const second = PAGE_TWO.replace('__HOME__', '/')
    const first = PAGE_ONE.replace('__SECOND__', '/second').replace('__MISSING_API__', '/api/session').replace('__BROKEN_IMAGE__', '/missing-image.png')

    if (url === '/' || url.startsWith('/?')) return send(200, 'text/html; charset=utf-8', first)
    if (url === '/second') return send(200, 'text/html; charset=utf-8', second)
    if (url === '/api/session') return send(404, 'application/json', '{"error":"not found"}')
    if (url.startsWith('/missing-image.png')) return send(404, 'text/plain', 'no image here')

    send(404, 'text/plain', 'not found')
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port

      // The on-disk copy is the same page with relative references, so it
      // behaves like a real document while staying off the network.
      let fileUrl = ''
      if (workDir) {
        const file = join(workDir, 'fixture-app.html')
        mkdirSync(workDir, { recursive: true })
        writeFileSync(
          file,
          PAGE_ONE
            .replace('__SECOND__', 'docs.html')
            .replace('__MISSING_API__', 'missing-api.json')
            .replace('__BROKEN_IMAGE__', 'missing-image.png'),
          'utf8'
        )
        writeFileSync(
          join(workDir, 'docs.html'),
          PAGE_TWO.replace('__HOME__', 'fixture-app.html'),
          'utf8'
        )
        fileUrl = `file:///${file.replace(/\\/g, '/')}`
      }

      resolve({
        server,
        port,
        url: `http://127.0.0.1:${port}`,
        fileUrl,
        multiPage: true,
        requestLog,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
          })
      })
    })
  })
}