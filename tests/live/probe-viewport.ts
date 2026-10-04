/**
 * Diagnostic probe: does the real `PageController` input path deliver events
 * where a raw protocol dispatch on the same tab does? Not part of the product.
 */

import { app, WebContentsView, session } from 'electron'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserTabManager } from '../../src/main/services/browser/tabs'
import { startFixture } from './browser-fixture'

function say(line: string): void {
  process.stdout.write(`${line}\n`)
}

async function main(): Promise<void> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'cryptoric-probe-'))
  await app.whenReady()
  const fixture = await startFixture()

  // A minimal HTTP page with no script and no subresources, to separate
  // "HTTP input is broken here" from "the fixture page is the problem".
  if (process.env['PROBE_URL']) {
    const ses = session.fromPath(join(userDataDir, 'plain'), { cache: true })
    const view = new WebContentsView({
      webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    view.webContents.debugger.attach('1.3')
    await view.webContents.loadURL(process.env['PROBE_URL'])
    await view.webContents.debugger.sendCommand('Page.enable')
    await view.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false
    })
    const r = (await view.webContents.executeJavaScriptInIsolatedWorld(9999, [
      { code: '(()=>{const r=document.getElementById("counter").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()' }
    ])) as { x: number; y: number }
    const d = (p: Record<string, unknown>): Promise<unknown> => view.webContents.debugger.sendCommand('Input.dispatchMouseEvent', p)
    await d({ type: 'mousePressed', x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 })
    await d({ type: 'mouseReleased', x: r.x, y: r.y, button: 'left', buttons: 0, clickCount: 1 })
    await new Promise((res) => setTimeout(res, 300))
    say(`PLAIN HTTP page -> count=${String(await view.webContents.executeJavaScript('document.getElementById("count").textContent'))} at (${r.x}, ${r.y})`)
  }

  // Control: a plain view, no manager, on the fixture's own URL.
  {
    const ses = session.fromPath(join(userDataDir, 'control'), { cache: true })
    const view = new WebContentsView({
      webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    view.webContents.debugger.attach('1.3')
    const target = process.env['PROBE_URL'] ?? fixture.url
    await view.webContents.loadURL(target)
    await view.webContents.debugger.sendCommand('Page.enable')
    await view.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false
    })
    const r = (await view.webContents.executeJavaScriptInIsolatedWorld(9999, [
      { code: '(()=>{const r=document.getElementById("counter").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()' }
    ])) as { x: number; y: number }
    await view.webContents.executeJavaScript(
      "(function(){var s=[];window.__seen=s;var t=['mousedown','mouseup','click'];" +
        'for(var i=0;i<t.length;i++){(function(n){document.addEventListener(n,function(e){' +
        's.push(n+\":\"+(e.target.id||e.target.tagName)+\":\"+Math.round(e.clientX)+\",\"+Math.round(e.clientY));},true);})(t[i]);}})()'
    )
    const d = (p: Record<string, unknown>): Promise<unknown> => view.webContents.debugger.sendCommand('Input.dispatchMouseEvent', p)
    const click = async (): Promise<void> => {
      await d({ type: 'mousePressed', x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 })
      await d({ type: 'mouseReleased', x: r.x, y: r.y, button: 'left', buttons: 0, clickCount: 1 })
      await new Promise((res) => setTimeout(res, 250))
    }
    const countOf = async (): Promise<string> =>
      String(await view.webContents.executeJavaScript('document.getElementById("count").textContent'))

    await click()
    say(`1 plain -> ${await countOf()}`)
    await view.webContents.executeJavaScript('window.__seen = []')
    await click()
    say(`2 plain again -> ${await countOf()} seen=${String(await view.webContents.executeJavaScript('JSON.stringify(window.__seen)'))}`)

    await view.webContents.debugger.sendCommand('Input.setIgnoreInputEvents', { ignore: false })
    await view.webContents.executeJavaScript('window.__seen = []')
    await click()
    say(`3 setIgnoreInputEvents(false) -> ${await countOf()} seen=${String(await view.webContents.executeJavaScript('JSON.stringify(window.__seen)'))}`)

    await view.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await view.webContents.executeJavaScript('window.__seen = []')
    await click()
    say(`4 focusEmulation -> ${await countOf()} seen=${String(await view.webContents.executeJavaScript('JSON.stringify(window.__seen)'))}`)

    await view.webContents.debugger.sendCommand('Page.bringToFront')
    await view.webContents.executeJavaScript('window.__seen = []')
    await click()
    say(`5 bringToFront -> ${await countOf()} seen=${String(await view.webContents.executeJavaScript('JSON.stringify(window.__seen)'))}`)

    say(`CONTROL final: ${String(await view.webContents.executeJavaScript('JSON.stringify({focus: document.hasFocus(), vv: [window.visualViewport ? window.visualViewport.width : -1, window.visualViewport ? window.visualViewport.height : -1]})'))}`)
  }

  const tabs = new BrowserTabManager({
    userDataDir,
    getWindow: () => null,
    backgroundHost: false
  })

  const tab = await tabs.open({ url: fixture.url, visible: false })
  say(`opened ${tab.id} at ${tab.url}`)
  await new Promise((r) => setTimeout(r, 800))

  const page = tabs.page(tab.id)
  if (!page) {
    say('no page')
    app.exit(1)
    return
  }

  const count = async (): Promise<string> => {
    const r = await page.call('getText', { selector: '#count' })
    return String(r.text ?? '')
  }

  say(`attached=${page.contents.debugger.isAttached()} viewport=${String(await page.hasViewport())}`)
  say(`start count=${await count()}`)

  const located = await page.call('locate', { selector: '#counter' })
  const rect = located.rect as { centerX: number; centerY: number }
  say(`locate -> ${JSON.stringify(located.ok)} ${JSON.stringify(rect)}`)

  await page.clickAt({ x: rect.centerX, y: rect.centerY })
  await new Promise((r) => setTimeout(r, 200))
  say(`after PageController.clickAt -> count=${await count()}`)

  // Raw dispatch on the very same tab, bypassing every wrapper.
  const wc = page.contents
  const send = (params: Record<string, unknown>): Promise<unknown> =>
    wc.debugger.sendCommand('Input.dispatchMouseEvent', params)
  await send({ type: 'mouseMoved', x: rect.centerX, y: rect.centerY, button: 'none', buttons: 0 })
  await send({ type: 'mousePressed', x: rect.centerX, y: rect.centerY, button: 'left', buttons: 1, clickCount: 1 })
  await send({ type: 'mouseReleased', x: rect.centerX, y: rect.centerY, button: 'left', buttons: 0, clickCount: 1 })
  await new Promise((r) => setTimeout(r, 200))
  say(`after raw dispatch -> count=${await count()}`)

  // Same tab, same page, but the mouse event sent with no modifiers and no
  // hover step, exactly as the working data:-URL probe did.
  await send({ type: 'mousePressed', x: rect.centerX, y: rect.centerY, button: 'left', buttons: 1, clickCount: 1 })
  await send({ type: 'mouseReleased', x: rect.centerX, y: rect.centerY, button: 'left', buttons: 0, clickCount: 1 })
  await new Promise((r) => setTimeout(r, 200))
  say(`after bare dispatch -> count=${await count()}`)

  // Does the page even receive a synthetic click through the DOM?
  const jsClick = await page.call('evaluateForProbe', {})
  void jsClick
  say(`listener attached: ${JSON.stringify(await page.contents.executeJavaScript('typeof window.__clickProbe'))}`)

  // And a second tab on the same origin, to separate "the page" from "the tab".
  const second = await tabs.open({ url: fixture.url, visible: false })
  await new Promise((r) => setTimeout(r, 600))
  const page2 = tabs.page(second.id)
  const l2 = await page2?.call('locate', { selector: '#counter' })
  const r2 = l2?.rect as { centerX: number; centerY: number }
  const d2 = (params: Record<string, unknown>): Promise<unknown> =>
    page2!.contents.debugger.sendCommand('Input.dispatchMouseEvent', params)
  await d2({ type: 'mousePressed', x: r2.centerX, y: r2.centerY, button: 'left', buttons: 1, clickCount: 1 })
  await d2({ type: 'mouseReleased', x: r2.centerX, y: r2.centerY, button: 'left', buttons: 0, clickCount: 1 })
  await new Promise((r) => setTimeout(r, 200))
  const c2 = await page2?.call('getText', { selector: '#count' })
  say(`second tab -> count=${String(c2?.text ?? '')}`)

  say(`elementAt -> ${JSON.stringify(await page.call('elementAt', { x: rect.centerX, y: rect.centerY }))}`)

  await tabs.closeAll()
  await fixture.close()
  say('done')
  app.exit(0)
}

main().catch((err) => {
  say(`FATAL ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  app.exit(1)
})