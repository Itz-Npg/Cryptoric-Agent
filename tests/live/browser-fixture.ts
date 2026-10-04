/**
 * A deliberately imperfect dev server for the live browser check.
 *
 * The point is that every defect the browser tools claim to detect is actually
 * present here: a console error with a stack, a 404 from an API call, a form
 * that validates client-side, a counter that only moves on a real click, an
 * element that appears late, and a second page to navigate to.
 *
 * Everything the newer tools need is here too, and is equally real: a hover
 * reveal, a mouse drag target, an enabled and a disabled checkbox, a confirm()
 * and a prompt(), a file that downloads with `Content-Disposition`, a session
 * cookie with a `/whoami` endpoint that reports it back, a redirect, and a
 * slow navigation triggered by a button.
 *
 * Nothing here is stubbed in the tools under test — the tools talk to this
 * server over real HTTP through real Chromium.
 */

import { createServer, type Server } from 'node:http'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
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
  #hover-panel { display: none; padding: 8px; border: 1px solid #888; }
  #hover-trigger:hover ~ #hover-panel { display: block; }
  #drop-zone { border: 2px dashed #444; padding: 24px; margin: 12px 0; }
  #low-contrast { color: #cfd2d6; background: #ffffff; }
  li { padding: 6px 10px; border: 1px solid #999; display: inline-block; margin-right: 8px; }
</style>
</head>
<body>
  <h1>Sign up</h1>
  <p id="intro">Create an account to continue.</p>

  <p class="counter">Clicks: <span id="count">0</span></p>
  <p id="count-detail">detail: 0</p>
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

    <p><label><input type="checkbox" id="terms" name="terms"> Accept the terms</label></p>
    <p><label><input type="checkbox" id="locked" disabled> Locked option</label></p>
    <p id="terms-state">terms: off</p>

    <p><button id="submit" type="submit">Create account</button></p>
    <p id="form-error" class="error" hidden></p>
  </form>

  <p><a id="second-link" href="__SECOND__">Read the docs</a></p>
  <div id="late" hidden>Late content appeared</div>
  <img id="logo" src="__BROKEN_IMAGE__" alt="Cryptoric logo" width="64" height="64">

  <h2>Hover</h2>
  <button id="hover-trigger" type="button">Hover me</button>
  <div id="hover-panel">Revealed on hover</div>
  <p id="hover-signal">hover: idle</p>

  <h2>Drag</h2>
  <ul>
    <li id="item-a" draggable="false">Alpha</li>
    <li id="item-b" draggable="false">Beta</li>
  </ul>
  <div id="drop-zone">Drop here</div>
  <p id="drop-count">drops: 0</p>
  <p id="last-drop">last: none</p>
  <p id="event-log" style="font-family: monospace; font-size: 12px;">events: none</p>

  <h2>Dialogs</h2>
  <button id="confirm-btn" type="button">Delete account</button>
  <button id="prompt-btn" type="button">Ask a question</button>
  <p id="dialog-result">dialog: none</p>
  <p id="prompt-result">prompt: none</p>

  <h2>Session</h2>
  <p id="whoami">session: unknown</p>
  <button id="refresh-whoami" type="button">Refresh session</button>
  <button id="slow-nav" type="button">Continue to the docs</button>
  <p><a id="download-link" href="__DOWNLOAD__" download="report.csv">Download the report</a></p>
  <p><a id="redirect-link" href="__REDIRECT__">Follow the redirect</a></p>

  <h2>Layout</h2>
  <p id="low-contrast">Barely visible text</p>
  <div id="wide" style="width: 1600px; height: 20px; background: #eeeeee;">Wide block</div>

  <h2>Generated assets</h2>
  <p>Images served from the asset workspace, so Chromium has to decode them for real.</p>
  <img class="probe" src="__ASSET__probe-png.png" alt="probe png" width="24" height="24">
  <img class="probe" src="__ASSET__probe-jpg.jpg" alt="probe jpg" width="24" height="24">
  <img class="probe" src="__ASSET__probe-webp.webp" alt="probe webp" width="24" height="24">
  <img class="probe" src="__ASSET__probe-gif.gif" alt="probe gif" width="24" height="24">

  <script>
    // A genuine console error, on purpose: the console tool must surface it.
    console.error('cryptoric-fixture: deliberate boot failure', { code: 'E_FIXTURE' });

    // A request that fails: the network tools must see a 4xx that console
    // never reports. Over HTTP this is a real 404 from the fixture server.
    fetch('__MISSING_API__').catch(function () {});

    var clicks = 0;
    document.getElementById('counter').addEventListener('click', function (event) {
      clicks += 1;
      document.getElementById('count').textContent = String(clicks);
      // A real double click is ONE click event with detail 2, not two events.
      // Recording the detail is how a test tells the two apart.
      document.getElementById('count-detail').textContent = 'detail: ' + event.detail;
    });

    document.getElementById('terms').addEventListener('change', function () {
      document.getElementById('terms-state').textContent = 'terms: ' + (this.checked ? 'on' : 'off');
    });

    document.getElementById('signup').addEventListener('submit', function (event) {
      event.preventDefault();
      var email = document.getElementById('email');
      var password = document.getElementById('password');
      var error = document.getElementById('form-error');
      if (email.value.indexOf('@') < 0) {
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

    // Hover: a CSS :hover reveal plus a marker the agent can read back, because
    // "the pointer moved" and "the page reacted" are different claims.
    document.getElementById('hover-trigger').addEventListener('mouseover', function () {
      document.getElementById('hover-signal').textContent = 'hover: over';
    });
    document.getElementById('hover-trigger').addEventListener('mouseout', function () {
      document.getElementById('hover-signal').textContent = 'hover: idle';
    });

    // Drag: a real pointer press-and-release sequence, with the release landing
    // on the zone. A single synthetic jump would miss it entirely.
    var carrying = null;
    var eventLog = [];
    function recordPointer(kind, event) {
      var target = event.target;
      var name = target && target.id ? target.id : (target ? target.tagName.toLowerCase() : '?');
      // The page re-derives what is at the delivered coordinates and records its
      // own scroll offset, so a mismatch between what a tool measured and what
      // the page received can be attributed to scrolling or to a coordinate
      // space difference instead of being guessed at.
      var hit = document.elementFromPoint(event.clientX, event.clientY);
      var hitName = hit ? (hit.id || hit.tagName.toLowerCase()) : 'none';
      eventLog.push(
        kind + ' ' + name + '@' + Math.round(event.clientX) + ',' + Math.round(event.clientY) +
        ' s' + Math.round(window.scrollY) + ' hit:' + hitName
      );
      document.getElementById('event-log').textContent =
        'events: ' + eventLog.slice(-10).join(' | ');
    }
    document.addEventListener('mousedown', function (event) { recordPointer('down', event); }, true);
    document.addEventListener('mouseup', function (event) { recordPointer('up', event); }, true);
    document.addEventListener('click', function (event) { recordPointer('click', event); }, true);

    ['item-a', 'item-b'].forEach(function (id) {
      document.getElementById(id).addEventListener('mousedown', function () {
        carrying = document.getElementById(id).textContent;
      });
    });
    document.getElementById('drop-zone').addEventListener('mouseup', function (event) {
      if (!carrying) return;
      var count = document.getElementById('drop-count');
      var parts = count.textContent.replace('drops: ', '').split(' ');
      count.textContent = 'drops: ' + (Number(parts[0]) + 1);
      document.getElementById('last-drop').textContent =
        'last: ' + carrying + ' at ' + Math.round(event.clientX) + ',' + Math.round(event.clientY);
      carrying = null;
    });

    document.getElementById('confirm-btn').addEventListener('click', function () {
      document.getElementById('dialog-result').textContent =
        confirm('Delete the account?') ? 'dialog: confirmed' : 'dialog: cancelled';
    });

    document.getElementById('prompt-btn').addEventListener('click', function () {
      document.getElementById('prompt-result').textContent =
        'prompt: ' + String(prompt('Your name?', ''));
    });

    // A cookie-backed session, so get_cookies and clear_cookies have something
    // real to act on rather than an empty jar.
    function refreshWhoami() {
      return fetch('__WHOAMI__')
        .then(function (response) { return response.json(); })
        .then(function (data) {
          document.getElementById('whoami').textContent =
            data.loggedIn ? 'session: signed in as ' + data.session : 'session: signed out';
        })
        .catch(function () {
          document.getElementById('whoami').textContent = 'session: unreachable';
        });
    }
    window.__cryptoricRefreshSession = refreshWhoami;
    refreshWhoami();
    document.getElementById('refresh-whoami').addEventListener('click', refreshWhoami);

    document.getElementById('slow-nav').addEventListener('click', function () {
      setTimeout(function () { location.href = '__SECOND__'; }, 400);
    });
  </script>
</body>
</html>`

const PAGE_TWO = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Cryptoric Test App — Docs</title></head>
<body><h1>Documentation</h1><p>The second page, reached by a real link click.</p>
<p><a id="home-link" href="__HOME__">Back to sign up</a></p></body></html>`

const CSV_REPORT = 'quarter,revenue,notes\nQ1,1200,grew\nQ2,1540,grew faster\nQ3,1610,flat\n'

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
  /**
   * Capabilities that only exist over HTTP.
   *
   * A `file:` document has an opaque origin: no cookies, no localStorage, and a
   * relative "download" link is just navigation. Those checks are skipped with
   * this reason rather than being quietly reported as passes.
   */
  httpOnly: readonly string[]
  requestLog: { method: string; url: string; status: number }[]
  close(): Promise<void>
}

/**
 * Substitute every placeholder in the page for a given base.
 *
 * `replaceAll`, not `replace`: several placeholders appear more than once (the
 * docs link and the delayed navigation both use `__SECOND__`), and a
 * single-occurrence replace leaves a literal `__SECOND__` in the script — which
 * then navigates to a 404 and reads as a broken feature rather than a typo.
 */
function render(base: string): string {
  return PAGE_ONE
    .replaceAll('__SECOND__', `${base}/second`)
    .replaceAll('__DOWNLOAD__', `${base}/download/report.csv`)
    .replaceAll('__REDIRECT__', `${base}/redirect`)
    .replaceAll('__WHOAMI__', `${base}/whoami`)
    .replaceAll('__ASSET__', `${base}/asset/`)
    .replaceAll('__MISSING_API__', `${base}/api/session`)
    .replaceAll('__BROKEN_IMAGE__', `${base}/missing-image.png`)
}

const ASSET_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

/** Start the fixture on an ephemeral port so parallel runs cannot collide. */
export function startFixture(workDir?: string, assetDir?: string): Promise<Fixture> {
  const requestLog: { method: string; url: string; status: number }[] = []
  let base = ''

  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    const send = (status: number, type: string, body: string): void => {
      requestLog.push({ method: req.method ?? 'GET', url, status })
      res.writeHead(status, { 'content-type': type })
      res.end(body)
    }

    if (url === '/' || url.startsWith('/?')) {
      requestLog.push({ method: req.method ?? 'GET', url, status: 200 })
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        // A real session cookie, set by the server, that the page reports back
        // through /whoami.
        'set-cookie': 'cryptoric_session=fixture-session-token; Path=/; SameSite=Lax'
      })
      return res.end(render(base))
    }
    if (url === '/second') return send(200, 'text/html; charset=utf-8', PAGE_TWO.replace('__HOME__', `${base}/`))
    if (url === '/redirect') {
      requestLog.push({ method: req.method ?? 'GET', url, status: 302 })
      res.writeHead(302, { location: '/second' })
      return res.end()
    }
    if (url.startsWith('/asset/')) {
      // Generated test assets, served from the same directory the upload tool
      // wrote them to. Reading the bytes off disk here is what makes the
      // "Chromium decoded it" check real rather than a claim.
      const name = url.slice('/asset/'.length).replace(/[?#].*$/, '')
      const path = assetDir ? join(assetDir, name) : ''
      const type = ASSET_TYPES[name.slice(name.lastIndexOf('.')).toLowerCase()]
      if (!path || !type || !existsSync(path)) return send(404, 'text/plain', 'no such asset')
      const bytes = readFileSync(path)
      requestLog.push({ method: req.method ?? 'GET', url, status: 200 })
      res.writeHead(200, { 'content-type': type, 'content-length': String(bytes.length) })
      return res.end(bytes)
    }
    if (url === '/whoami') {
      const cookies = String(req.headers.cookie ?? '')
      const match = /cryptoric_session=([^;]+)/.exec(cookies)
      return send(200, 'application/json', JSON.stringify({ loggedIn: Boolean(match), session: match ? match[1] : null }))
    }
    if (url === '/download/report.csv') {
      requestLog.push({ method: req.method ?? 'GET', url, status: 200 })
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="report.csv"',
        'content-length': String(Buffer.byteLength(CSV_REPORT))
      })
      return res.end(CSV_REPORT)
    }
    if (url === '/api/session') return send(404, 'application/json', '{"error":"not found"}')
    if (url.startsWith('/missing-image.png')) return send(404, 'text/plain', 'no image here')

    send(404, 'text/plain', 'not found')
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      base = `http://127.0.0.1:${port}`

      // The on-disk copy is the same page with relative references, so it
      // behaves like a real document while staying off the network.
      let fileUrl = ''
      if (workDir) {
        const file = join(workDir, 'fixture-app.html')
        mkdirSync(workDir, { recursive: true })
        writeFileSync(
          file,
          render('.')
            .replaceAll('__SECOND__', 'docs.html')
            .replaceAll('__DOWNLOAD__', 'report.csv')
            .replaceAll('__REDIRECT__', 'redirect.html')
            .replaceAll('__WHOAMI__', 'whoami.json')
            .replaceAll('__ASSET__', 'assets/')
            .replaceAll('__MISSING_API__', 'missing-api.json')
            .replaceAll('__BROKEN_IMAGE__', 'missing-image.png'),
          'utf8'
        )
        writeFileSync(join(workDir, 'docs.html'), PAGE_TWO.replace('__HOME__', 'fixture-app.html'), 'utf8')
        writeFileSync(join(workDir, 'redirect.html'), PAGE_TWO.replace('__HOME__', 'fixture-app.html'), 'utf8')
        writeFileSync(join(workDir, 'report.csv'), CSV_REPORT, 'utf8')
        writeFileSync(join(workDir, 'whoami.json'), '{"loggedIn":false,"session":null}', 'utf8')
        fileUrl = `file:///${file.replace(/\\/g, '/')}`
      }

      resolve({
        server,
        port,
        url: base,
        fileUrl,
        multiPage: true,
        httpOnly: ['cookies', 'localStorage', 'sessionStorage', 'download'],
        requestLog,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
          })
      })
    })
  })
}
