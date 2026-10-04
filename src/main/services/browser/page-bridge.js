/**
 * Page-side automation bridge.
 *
 * This file is never imported as a module — it is loaded with Vite's `?raw`
 * and evaluated inside an **isolated world** of the tab's renderer, by
 * `page.ts`. Two consequences shape everything below:
 *
 *  1. The page cannot see or tamper with it. `window.__cryptoric` does not
 *     exist in the page's own world, so a hostile dev server cannot forge a
 *     `browser_get_text` result, redefine `document.querySelector` out from
 *     under us, or install a getter that hangs the call.
 *  2. It is re-created on every navigation, because an isolated world's
 *     globals die with the document. `page.ts` re-installs lazily.
 *
 * Every exported function is **synchronous**. All waiting happens in the main
 * process: `executeJavaScriptInIsolatedWorld` resolves on the script's
 * completion value and does not reliably await a returned promise, so a
 * promise-returning helper would be a source of hangs that only reproduce
 * under load.
 *
 * Selector syntax: plain CSS, plus two documented extensions because agents
 * reach for them constantly and a raw-CSS-only tool makes them guess:
 *   text="Sign in"     exact visible-text match
 *   text~="Sign"       substring match
 */
;(function installCryptoricBridge() {
  'use strict'
  if (globalThis.__cryptoric) return 'already-installed'

  var MAX_TEXT = 200000
  var MAX_DOM = 400000
  var MAX_NODES = 500

  function clip(text, max) {
    text = String(text == null ? '' : text)
    if (text.length <= max) return text
    return text.slice(0, max) + '\n… [' + (text.length - max) + ' more characters]'
  }

  /** Text of an element as a user would see it; `innerText` already excludes hidden nodes. */
  function visibleText(node) {
    if (!node) return ''
    if (node === document.body || node === document.documentElement) {
      return node.innerText || node.textContent || ''
    }
    return node.innerText || node.textContent || ''
  }

  function isVisible(node) {
    if (!node || !node.getBoundingClientRect) return false
    var rect = node.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    var style = window.getComputedStyle(node)
    if (!style) return true
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false
    if (style.display === 'none') return false
    if (Number(style.opacity) === 0) return false
    return true
  }

  /** Centre point in viewport CSS pixels — exactly what `Input.dispatchMouseEvent` wants. */
  function rectOf(node) {
    var rect = node.getBoundingClientRect()
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2
    }
  }

  function attr(node, name) {
    return node.getAttribute ? node.getAttribute(name) : null
  }

  function shortText(text) {
    return clip(String(text || '').replace(/\s+/g, ' ').trim(), 160)
  }

  function describe(node, index) {
    var rect = rectOf(node)
    return {
      index: index,
      tag: node.tagName ? node.tagName.toLowerCase() : String(node.nodeName || '').toLowerCase(),
      id: node.id || '',
      classes: typeof node.className === 'string' && node.className ? node.className.split(/\s+/) : [],
      role: attr(node, 'role') || '',
      text: shortText(visibleText(node)),
      name: attr(node, 'name') || '',
      type: attr(node, 'type') || '',
      href: attr(node, 'href') || '',
      placeholder: attr(node, 'placeholder') || '',
      ariaLabel: attr(node, 'aria-label') || '',
      testId: attr(node, 'data-testid') || attr(node, 'data-test') || attr(node, 'data-qa') || '',
      disabled: !!node.disabled,
      checked: !!node.checked,
      value: node.tagName === 'SELECT' ? '' : String(node.value == null ? '' : node.value).slice(0, 200),
      visible: isVisible(node),
      inViewport:
        rect.centerX >= 0 && rect.centerY >= 0 && rect.width > 0 && rect.height > 0 &&
        rect.x < window.innerWidth && rect.y < window.innerHeight,
      rect: rect
    }
  }

  /** Resolve the selector extensions, then plain CSS. */
  function cssNodes(selector) {
    return Array.prototype.slice.call(document.querySelectorAll(selector))
  }

  function textNodes(selector, substring) {
    var needle = selector.toLowerCase()
    var all = Array.prototype.slice.call(document.querySelectorAll('body *'))
    var hits = []
    for (var i = 0; i < all.length && hits.length < MAX_NODES; i++) {
      var node = all[i]
      if (node.children && node.children.length > 0) continue
      var own = node.textContent || ''
      var hit = substring ? own.toLowerCase().indexOf(needle) >= 0 : own.trim() === needle
      if (hit) hits.push(node)
    }
    return hits
  }

  function rawMatches(selector) {
    var trimmed = String(selector || '').trim()
    if (trimmed === '') return { ok: false, reason: 'Empty selector.' }

    if (trimmed.indexOf('text~=') === 0) {
      var needle = trimmed.slice(6).replace(/^["']|["']$/g, '')
      return { ok: true, nodes: textNodes(needle, true), kind: 'text~' }
    }
    if (trimmed.indexOf('text=') === 0) {
      var exact = trimmed.slice(5).replace(/^["']|["']$/g, '')
      return { ok: exact.length > 0, nodes: textNodes(exact, false), kind: 'text' }
    }
    if (trimmed.indexOf('css=') === 0) trimmed = trimmed.slice(4)

    try {
      return { ok: true, nodes: cssNodes(trimmed), kind: 'css' }
    } catch (err) {
      return { ok: false, reason: 'Invalid CSS selector: ' + trimmed }
    }
  }

  /**
   * Resolve to a single element, preferring a visible one.
   *
   * An agent that says `button` means "the button a user would click". When a
   * template renders hidden desktop and mobile variants of the same control,
   * picking the hidden one produces a click on nothing.
   */
  function pick(selector, index) {
    var match = rawMatches(selector)
    if (!match.ok) return { ok: false, reason: match.reason, count: 0 }
    var nodes = match.nodes
    if (nodes.length === 0) return { ok: false, reason: 'No element matches ' + selector, count: 0 }

    var chosen = null
    if (typeof index === 'number' && index >= 0) {
      if (index >= nodes.length) {
        return { ok: false, reason: 'Index ' + index + ' is out of range; ' + nodes.length + ' match ' + selector, count: nodes.length }
      }
      chosen = nodes[index]
    } else {
      for (var i = 0; i < nodes.length; i++) {
        if (isVisible(nodes[i])) { chosen = nodes[i]; break }
      }
      if (!chosen) chosen = nodes[0]
    }
    return { ok: true, node: chosen, count: nodes.length, visible: isVisible(chosen), kind: match.kind }
  }

  /** Bring the target into view, then report where a real pointer event should land. */
  function locate(selector, index) {
    var found = pick(selector, index)
    if (!found.ok) return found
    var node = found.node
    if (!isVisible(node)) {
      return { ok: false, reason: 'Element matches ' + selector + ' but is not visible (display:none, visibility:hidden or zero size).', count: found.count }
    }
    try {
      if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    } catch (err) {
      /* instant scrolling is best-effort; the rect below is authoritative */
    }
    return {
      ok: true,
      count: found.count,
      rect: rectOf(node),
      visible: true,
      descriptor: describe(node, typeof index === 'number' ? index : 0)
    }
  }

  /** Focus without synthesising a click — used before typing. */
  function focusTarget(selector, index) {
    var found = pick(selector, index)
    if (!found.ok) return found
    var node = found.node
    try {
      if (typeof node.focus === 'function') node.focus({ preventScroll: true })
    } catch (err) {
      /* some inputs throw on programmatic focus; the click path still works */
    }
    return {
      ok: true,
      count: found.count,
      focused: document.activeElement === node,
      rect: rectOf(node),
      descriptor: describe(node, typeof index === 'number' ? index : 0)
    }
  }

  /**
   * Commit a value to a form control.
   *
   * React and most other frameworks install their own `value` setter, so
   * assigning `element.value` alone is silently discarded on the next render.
   * The native setter plus a bubbling `input` and `change` event is the
   * smallest sequence that every framework in practical use observes.
   */
  function setValue(selector, value, index) {
    var found = pick(selector, index)
    if (!found.ok) return found
    var node = found.node
    var tag = node.tagName ? node.tagName.toUpperCase() : ''
    var type = (attr(node, 'type') || '').toLowerCase()

    if (tag === 'SELECT') {
      var wanted = String(value == null ? '' : value)
      var matched = null
      var options = Array.prototype.slice.call(node.options)
      for (var i = 0; i < options.length; i++) {
        var opt = options[i]
        if (opt.value === wanted || opt.text === wanted) { matched = opt; break }
      }
      if (!matched) {
        return {
          ok: false,
          reason: 'No option matching "' + wanted + '"',
          count: found.count,
          available: options.slice(0, 100).map(function (o) { return o.value })
        }
      }
      var nativeSelect = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')
      if (nativeSelect && nativeSelect.set) nativeSelect.set.call(node, matched.value)
      else node.value = matched.value
      node.dispatchEvent(new Event('input', { bubbles: true }))
      node.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: true, count: found.count, value: node.value, text: matched.text, kind: 'select' }
    }

    if (type === 'checkbox' || type === 'radio') {
      var want = value === true || value === 'true' || value === 1 || value === '1'
      if (node.checked !== want) {
        node.click()
      }
      return { ok: true, count: found.count, value: node.checked, kind: type }
    }

    var nativeInput = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(node) || window.HTMLInputElement.prototype,
      'value'
    )
    if (nativeInput && nativeInput.set) nativeInput.set.call(node, String(value == null ? '' : value))
    else node.value = String(value == null ? '' : value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
    node.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, count: found.count, value: node.value, kind: tag.toLowerCase() }
  }

  function meta() {
    var body = document.body
    return {
      url: location.href,
      title: document.title || '',
      readyState: document.readyState,
      textLength: body ? (body.innerText || '').length : 0,
      nodeCount: document.getElementsByTagName('*').length,
      scrollY: window.scrollY || window.pageYOffset || 0,
      scrollX: window.scrollX || window.pageXOffset || 0,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollHeight: document.documentElement ? document.documentElement.scrollHeight : 0,
      dialogsOpen: 0
    }
  }

  /** Frame accessibility: what a screen reader sees, not what the DOM says. */
  function landmarks() {
    var roles = ['main', 'navigation', 'banner', 'contentinfo', 'form', 'dialog', 'alert', 'status']
    var found = []
    for (var i = 0; i < roles.length; i++) {
      var nodes = document.querySelectorAll('[role="' + roles[i] + '"], ' + roles[i])
      if (nodes.length) found.push({ role: roles[i], count: nodes.length })
    }
    return found
  }

  globalThis.__cryptoric = {
    version: 1,
    meta: meta,
    landmarks: landmarks,
    locate: function (args) { return locate(args.selector, args.index) },
    /** Every attribute on one element, values clipped so a data blob cannot flood the reply. */
    attributes: function (args) {
      var found = pick(args.selector, args.index)
      if (!found.ok) return found
      var node = found.node
      var out = {}
      if (node.attributes) {
        for (var i = 0; i < node.attributes.length && i < 80; i++) {
          out[node.attributes[i].name] = String(node.attributes[i].value).slice(0, 1000)
        }
      }
      return {
        ok: true,
        selector: args.selector,
        attributes: out,
        element: describe(node, 0),
        style: inlineStyleOf(node)
      }
    },
    /**
     * Resolved CSS for one element.
     *
     * Reports the computed value, not the declared one: "is this element
     * actually hidden" and "does this text actually have contrast" are both
     * questions only the computed style can answer.
     */
    computedStyle: function (args) {
      var found = pick(args.selector, args.index)
      if (!found.ok) return found
      var node = found.node
      var computed = window.getComputedStyle(node)
      var wanted = args.properties && args.properties.length ? args.properties : null
      var result = {}
      if (wanted) {
        for (var w = 0; w < wanted.length; w++) {
          var property = String(wanted[w])
          result[property] = computed.getPropertyValue(property)
        }
      } else {
        for (var c = 0; c < computed.length && c < 200; c++) {
          result[computed[c]] = computed.getPropertyValue(computed[c])
        }
      }
      var rect = rectOf(node)
      return {
        ok: true,
        selector: args.selector,
        properties: result,
        visible: isVisible(node),
        rect: rect,
        overflowsViewport: rect.x < 0 || rect.y < 0 || rect.x + rect.width > window.innerWidth,
        clipped: rect.y + rect.height > (document.documentElement ? document.documentElement.scrollHeight : window.innerHeight),
        color: computed.color,
        backgroundColor: computed.backgroundColor,
        fontSize: computed.fontSize,
        contrast: contrastRatio(computed.color, effectiveBackground(node))
      }
    },
    /** Layout facts used by the responsive and visual checks. */
    layoutReport: function (args) {
      var doc = document.documentElement
      var body = document.body
      var widest = null
      var offenders = []
      var nodes = body ? body.getElementsByTagName('*') : []
      for (var i = 0; i < nodes.length && offenders.length < 25; i++) {
        var node = nodes[i]
        var rect = node.getBoundingClientRect()
        if (rect.width <= 0) continue
        if (rect.right > window.innerWidth + 1 || rect.left < -1) {
          offenders.push({
            tag: node.tagName.toLowerCase(),
            id: node.id || '',
            classes: typeof node.className === 'string' ? node.className.split(/\s+/).slice(0, 6) : [],
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            width: Math.round(rect.width)
          })
          if (!widest || rect.right > widest.right) widest = offenders[offenders.length - 1]
        }
      }
      var brokenImages = imageReport().broken
      return {
        ok: true,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        document: { scrollWidth: doc ? doc.scrollWidth : 0, scrollHeight: doc ? doc.scrollHeight : 0 },
        horizontalOverflow: doc ? doc.scrollWidth > window.innerWidth + 1 : false,
        offenders: offenders,
        widest: widest,
        brokenImages: brokenImages.length,
        images: document.images.length
      }
    },
    /** Storage with a writable surface, for `browser_set_storage`. */
    setStorage: function (args) {
      var area = args.area === 'session' ? window.sessionStorage : window.localStorage
      if (!area) return { ok: false, reason: 'That storage area is unavailable on this origin.' }
      if (args.remove) {
        try {
          area.removeItem(args.key)
          return { ok: true, removed: args.key, area: args.area || 'local' }
        } catch (err) {
          return { ok: false, reason: String(err && err.message ? err.message : err) }
        }
      }
      try {
        if (args.clear) {
          area.clear()
          return { ok: true, cleared: true, area: args.area || 'local' }
        }
        area.setItem(args.key, String(args.value == null ? '' : args.value))
        return { ok: true, key: args.key, area: args.area || 'local' }
      } catch (err) {
        // Quota exceeded and SecurityError are both real answers, not crashes.
        return { ok: false, reason: 'Storage refused the write: ' + String(err && err.message ? err.message : err) }
      }
    },
    /**
     * What is at a viewport coordinate.
     *
     * The fastest way to tell a coordinate-space bug from a page bug: if this
     * does not return the element that was clicked, the coordinates the agent
     * computed do not match the page's viewport.
     */
    elementAt: function (args) {
      var x = Number(args.x)
      var y = Number(args.y)
      var node = document.elementFromPoint(x, y)
      if (!node) return { ok: false, reason: 'Nothing at ' + x + ',' + y, x: x, y: y, viewport: [innerWidth, innerHeight] }
      return {
        ok: true,
        x: x,
        y: y,
        viewport: [innerWidth, innerHeight],
        scroll: [window.scrollX || 0, window.scrollY || 0],
        element: describe(node, 0),
        path: (function () {
          var parts = []
          var current = node
          while (current && current.nodeType === 1 && parts.length < 6) {
            parts.push(current.tagName.toLowerCase() + (current.id ? '#' + current.id : ''))
            current = current.parentElement
          }
          return parts.join(' > ')
        })()
      }
    },
    /**
     * Scroll an element into view and report where it ended up.
     *
     * Every other coordinate in this bridge comes from `getBoundingClientRect`,
     * which is viewport-relative: an element below the fold reports a `y` past
     * the bottom of the window, and a pointer event dispatched there lands
     * nowhere. Chromium then reports a successful click on the wrong thing, so
     * the agent acts on a page state it never touched. Scrolling first is what
     * makes the coordinates mean what they say.
     */
    reveal: function (args) {
      var found = pick(args.selector, args.index)
      if (!found.ok) return found
      var node = found.node
      var before = rectOf(node)
      var inView = before.y >= 0 && before.y + before.height <= window.innerHeight &&
        before.x >= 0 && before.x + before.width <= window.innerWidth
      if (!inView && args.scroll !== false) {
        node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' })
      }
      // A scroll is applied to the document scroller asynchronously, so the very
      // first read after it can still describe the previous position. Reading
      // until two consecutive reads agree is what makes the coordinates handed
      // to the pointer actually describe where the element is now.
      var after = rectOf(node)
      for (var settle = 0; settle < 3; settle++) {
        var again = rectOf(node)
        if (again.x === after.x && again.y === after.y) break
        after = again
      }
      return {
        ok: true,
        selector: args.selector,
        scrolled: !inView,
        before: before,
        rect: after,
        descriptor: describe(node, args.index),
        viewport: [window.innerWidth, window.innerHeight],
        inViewport:
          after.centerX >= 0 && after.centerY >= 0 && after.centerX <= window.innerWidth &&
          after.centerY <= window.innerHeight
      }
    },
    /**
     * Select everything a text field holds, so a following Delete is a real
     * user gesture rather than a scripted value overwrite.
     */
    selectAll: function (args) {
      var found = pick(args.selector, args.index)
      if (!found.ok) return found
      var node = found.node
      var tag = node.tagName ? node.tagName.toUpperCase() : ''
      if (typeof node.focus === 'function') node.focus()
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        if (typeof node.select === 'function') {
          node.select()
          return { ok: true, selector: args.selector, method: 'select', length: String(node.value || '').length }
        }
        return { ok: false, reason: 'This input does not support text selection.' }
      }
      if (node.isContentEditable) {
        var range = document.createRange()
        range.selectNodeContents(node)
        var selection = window.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
        return { ok: true, selector: args.selector, method: 'range', length: String(node.textContent || '').length }
      }
      return { ok: false, reason: 'That element has no selectable text content.' }
    },
    focus: function (args) { return focusTarget(args.selector, args.index) },
    /** Read back what a field holds after typing, so the agent can verify it landed. */
    getValue: function (args) {
      var found = pick(args.selector, args.index)
      if (!found.ok) return found
      var node = found.node
      var value = node.tagName === 'SELECT'
        ? { value: node.value, text: node.options[node.selectedIndex] ? node.options[node.selectedIndex].text : '' }
        : { value: String(node.value == null ? '' : node.value), checked: !!node.checked }
      if (node.files) {
        var names = []
        for (var f = 0; f < node.files.length && f < 20; f++) {
          var file = node.files[f]
          names.push({ name: file.name, bytes: file.size, type: file.type })
        }
        value.fileCount = node.files.length
        value.files = names
      }
      return { ok: true, selector: args.selector, value: value, descriptor: describe(node, 0) }
    },
    setValue: function (args) { return setValue(args.selector, args.value, args.index) },
    getText: function (args) {
      var selector = args && args.selector
      var max = (args && args.maxChars) || MAX_TEXT
      if (!selector) {
        return { ok: true, selector: null, text: clip(bodyText(), max), scope: 'document' }
      }
      var found = pick(selector, args.index)
      if (!found.ok) return found
      return { ok: true, selector: selector, text: clip(visibleText(found.node), max), scope: 'element' }
    },
    getDom: function (args) {
      var selector = args && args.selector
      var max = (args && args.maxChars) || MAX_DOM
      var target = document.documentElement
      if (selector) {
        var found = pick(selector, args.index)
        if (!found.ok) return found
        target = found.node
      }
      var html = target.outerHTML || ''
      return { ok: true, selector: selector || null, html: clip(html, max), length: html.length }
    },
    query: function (args) {
      var selector = args.selector
      var limit = Math.min(args.limit || 50, MAX_NODES)
      var match = rawMatches(selector)
      if (!match.ok) return match
      var nodes = match.nodes.slice(0, limit)
      var items = []
      for (var i = 0; i < nodes.length; i++) items.push(describe(nodes[i], i))
      return { ok: true, selector: selector, total: match.nodes.length, returned: items.length, kind: match.kind, items: items }
    },
    /**
     * Storage visible to this origin. An isolated world shares the page's
     * storage partition, so keys and values read here are the page's real
     * ones — which is what an agent debugging "my session never persists" needs.
     */
    storage: function () {
      var local = {}
      var session = {}
      var sessionKeys = []
      try {
        var localKeys = keysOf(window.localStorage)
        for (var i = 0; i < localKeys.length; i++) {
          var k = localKeys[i]
          local[k] = String(window.localStorage.getItem(k)).slice(0, 1000)
        }
      } catch (err) { /* opaque origin */ }
      try {
        sessionKeys = keysOf(window.sessionStorage)
        for (var j = 0; j < sessionKeys.length; j++) {
          session[sessionKeys[j]] = String(window.sessionStorage.getItem(sessionKeys[j])).slice(0, 1000)
        }
      } catch (err) { /* opaque origin */ }
      return {
        ok: true,
        origin: location.origin,
        localStorage: local,
        sessionStorage: session,
        sessionStorageKeys: sessionKeys
      }
    },
    scrollBy: function (args) {
      var dx = Number(args.dx) || 0
      var dy = Number(args.dy) || 0
      window.scrollBy(dx, dy)
      var element = args.selector ? pick(args.selector, args.index) : null
      if (element && element.ok) {
        try { element.node.scrollBy(dx, dy) } catch (err) { /* not scrollable */ }
      }
      return meta()
    },
    scrollTo: function (args) {
      if (args.selector) {
        var found = pick(args.selector, args.index)
        if (!found.ok) return found
        try { found.node.scrollIntoView({ block: 'center', behavior: 'instant' }) } catch (err) { /* ignore */ }
        return meta()
      }
      window.scrollTo(Number(args.x) || 0, Number(args.y) || 0)
      return meta()
    },
    /**
     * The deliberately small evaluation surface behind `browser_evaluate_safe`.
     *
     * It runs *named* probes over the page; it never evaluates agent-authored
     * script. A general `eval` here would be arbitrary code execution inside
     * the developer's signed-in origin, and a denylist does not stop that —
     * one `fetch()` to an attacker's host exfiltrates a page full of session
     * state. Fixed probes answer the questions the agent actually asks
     * ("what does the form think its values are?") with no channel out.
     */
    probe: function (args) {
      var name = (args && args.probe) || 'summary'
      var selector = args && args.selector

      if (name === 'element') {
        if (!selector) return { ok: false, reason: 'The element probe needs a selector.' }
        var found = pick(selector, args.index)
        if (!found.ok) return found
        return { ok: true, probe: name, element: describe(found.node, 0), attributes: attributesOf(found.node) }
      }

      if (name === 'form' || name === 'fields') {
        return formReport(selector, args.index)
      }

      if (name === 'images') {
        return imageReport()
      }

      if (name === 'headings') {
        return headingReport()
      }

      if (name === 'timing') {
        return timingReport()
      }

      if (name !== 'summary') {
        return { ok: false, reason: 'Unknown probe: ' + name }
      }

      return {
        ok: true,
        probe: 'summary',
        url: location.href,
        title: document.title || '',
        readyState: document.readyState,
        forms: document.forms.length,
        inputs: document.querySelectorAll('input, textarea, select').length,
        buttons: document.querySelectorAll('button, [role="button"], input[type="submit"]').length,
        links: document.querySelectorAll('a[href]').length,
        images: document.querySelectorAll('img').length,
        imagesBroken: countBrokenImages(),
        scripts: document.scripts.length,
        landmarks: landmarks(),
        meta: meta()
      }
    }
  }

  /**
   * Report what a form actually holds right now.
   *
   * Reading `input.value` from a React-controlled field can disagree with what
   * is on screen when state and DOM have drifted; reporting `defaultValue`
   * alongside `value` makes that drift visible instead of hiding it.
   */
  function formReport(selector, index) {
    var forms = []
    var list = selector ? queryAll(selector, index) : document.forms
    var scope = selector ? list : Array.prototype.slice.call(list)
    if (selector && scope.length === 0) return { ok: false, reason: 'No form matches ' + selector, count: 0 }

    for (var f = 0; f < scope.length && f < 10; f++) {
      var form = scope[f]
      var fields = []
      var controls = form.elements ? Array.prototype.slice.call(form.elements) : []
      for (var c = 0; c < controls.length && c < 200; c++) {
        var el = controls[c]
        if (!el.name && !el.id) continue
        fields.push({
          name: el.name || el.id,
          tag: el.tagName ? el.tagName.toLowerCase() : '',
          type: (attr(el, 'type') || (el.tagName === 'BUTTON' ? 'submit' : '')).toLowerCase(),
          value: el.tagName === 'SELECT' ? String(el.value || '') : String(el.value == null ? '' : el.value).slice(0, 300),
          defaultValue: String(el.defaultValue == null ? '' : el.defaultValue).slice(0, 300),
          checked: !!el.checked,
          disabled: !!el.disabled,
          required: !!el.required,
          valid: typeof el.checkValidity === 'function' ? el.checkValidity() : null,
          // A field the framework owns but that is not in the DOM value is the
          // classic "React says it is fine, the browser disagrees" symptom.
          inDom: !!el.id || !!el.name
        })
      }
      forms.push({
        index: f,
        id: form.id || '',
        name: form.name || '',
        action: form.action || '',
        method: (form.method || 'get').toLowerCase(),
        visible: isVisible(form),
        fieldCount: fields.length,
        fields: fields
      })
    }
    return { ok: true, probe: 'form', selector: selector || null, forms: forms }
  }

  function queryAll(selector, index) {
    var match = rawMatches(selector)
    if (!match.ok) return []
    if (typeof index === 'number' && index >= 0) return match.nodes.slice(index, index + 1)
    return match.nodes.slice(0, 1)
  }

  function imageReport() {
    var images = document.images
    var broken = []
    for (var i = 0; i < images.length && broken.length < 50; i++) {
      var img = images[i]
      if (img.complete && img.naturalWidth > 0) continue
      broken.push({
        src: String(img.currentSrc || img.src || '').slice(0, 400),
        alt: img.alt || '',
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        complete: img.complete,
        visible: isVisible(img)
      })
    }
    return { ok: true, probe: 'images', total: images.length, brokenCount: broken.length, broken: broken }
  }

  function headingReport() {
    var out = []
    var nodes = document.querySelectorAll('h1, h2, h3, h4, h5, h6')
    for (var i = 0; i < nodes.length && out.length < 100; i++) {
      out.push({ level: Number(nodes[i].tagName.slice(1)), text: shortText(nodes[i].textContent) })
    }
    return { ok: true, probe: 'headings', count: out.length, headings: out }
  }

  function timingReport() {
    if (!window.performance || !window.performance.getEntriesByType) {
      return { ok: true, probe: 'timing', entries: [], note: 'Performance API unavailable.' }
    }
    var entries = window.performance.getEntriesByType('navigation')
    var paints = window.performance.getEntriesByType('paint')
    var nav = entries.length ? entries[0] : null
    return {
      ok: true,
      probe: 'timing',
      domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      loadMs: nav ? Math.round(nav.loadEventEnd) : null,
      responseMs: nav ? Math.round(nav.responseEnd) : null,
      transferSize: nav ? nav.transferSize : null,
      firstPaintMs: paints.length ? Math.round(paints[0].startTime) : null
    }
  }

  function keysOf(storage) {
    try {
      var out = []
      for (var i = 0; i < storage.length && i < 200; i++) out.push(storage.key(i))
      return out
    } catch (err) {
      // Storage access throws on a sandboxed or opaque origin.
      return []
    }
  }

  function inlineStyleOf(node) {
    var style = node.getAttribute ? node.getAttribute('style') : null
    if (!style) return {}
    var out = {}
    var parts = style.split(';')
    for (var i = 0; i < parts.length; i++) {
      var index = parts[i].indexOf(':')
      if (index < 0) continue
      out[parts[i].slice(0, index).trim()] = parts[i].slice(index + 1).trim()
    }
    return out
  }

  /**
   * The nearest non-transparent background behind an element.
   *
   * Walking up matters: a page that sets `color` on the body and leaves every
   * card transparent still has a real background, and reading the card alone
   * would report "transparent" and skip a genuine contrast finding.
   */
  function effectiveBackground(node) {
    var current = node
    while (current && current.nodeType === 1) {
      var color = window.getComputedStyle(current).backgroundColor
      if (color && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/.test(color)) return color
      current = current.parentElement
    }
    return 'rgb(255, 255, 255)'
  }

  function parseColor(value) {
    var match = /rgba?\(([^)]+)\)/.exec(String(value || ''))
    if (!match) return null
    var parts = match[1].split(',').map(function (p) { return parseFloat(p.trim()) })
    return { r: parts[0] || 0, g: parts[1] || 0, b: parts[2] || 0, a: parts.length > 3 ? parts[3] : 1 }
  }

  /** WCAG relative-luminance contrast ratio. 1 is invisible, 21 is maximal. */
  function contrastRatio(foreground, background) {
    var a = parseColor(foreground)
    var b = parseColor(background)
    if (!a || !b || a.a === 0) return null
    var l1 = luminance(a)
    var l2 = luminance(b)
    var lighter = Math.max(l1, l2)
    var darker = Math.min(l1, l2)
    return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100
  }

  function luminance(color) {
    function channel(value) {
      var v = value / 255
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
  }

  function attributesOf(node) {
    var out = {}
    if (!node.attributes) return out
    for (var i = 0; i < node.attributes.length && i < 60; i++) {
      var name = node.attributes[i].name
      out[name] = String(node.attributes[i].value).slice(0, 500)
    }
    return out
  }

  function countBrokenImages() {
    var images = document.images
    var broken = 0
    for (var i = 0; i < images.length; i++) {
      if (!images[i].complete || images[i].naturalWidth === 0) broken += 1
    }
    return broken
  }

  function bodyText() {
    var body = document.body
    if (!body) return ''
    return body.innerText || body.textContent || ''
  }

  return 'installed'
})()