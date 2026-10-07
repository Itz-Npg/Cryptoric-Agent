/**
 * PromptBar — the prompt composer.
 *
 * Adapted from the React Bits component of the same name. The upstream source is
 * JavaScript with hard-coded dark colours; this build is TypeScript and takes its
 * surface, ink and spark from the app's own tokens, so it follows Graphite and
 * Bone instead of fighting them.
 *
 * What it replaces and why the upgrade is real rather than cosmetic: the previous
 * composer was a `<textarea>` and a Send button, which meant the only way to say
 * anything was to type it. This one carries the three affordances a coding agent
 * actually needs at the point of asking —
 *
 *  - `@` inserts a **reference to a real file in the open project**, which the
 *    model can then read, instead of the user typing a path from memory;
 *  - `/` inserts one of the project's **own skills**, which are what the app
 *    already routes on, so the menu offers the commands that will work;
 *  - the tile is also the **stop** control while a task runs, so the thing that
 *    starts work is the thing that ends it.
 *
 * The arrow-to-square morph is drawn, not swapped: `pathAt` interpolates the two
 * point lists and a motion value drives it, so the glyph is a single continuous
 * shape. A cross-fade between two icons reads as a glitch at any speed a person
 * can see.
 */

import {
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'
import { useReducedMotion } from 'motion/react'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import {
  ArrowDown01Icon,
  Attachment01Icon,
  Calendar03Icon,
  Cancel01Icon,
  ChartLineData01Icon,
  File02Icon,
  Globe02Icon,
  HelpCircleIcon,
  Mail01Icon,
  Mic01Icon,
  PlusSignIcon,
  SparklesIcon,
  Tick02Icon
} from '@hugeicons/core-free-icons'
import './PromptBar.css'

/** Where the tile's glyph starts: a paper-plane-ish arrow. */
const ARROW_UP = [12, 4.5, 18.5, 11, 14.25, 11, 14.25, 19.5, 9.75, 19.5, 9.75, 11, 5.5, 11]
/** Where it lands: the stop square. */
const SQUARE = [12, 6, 18, 6, 18, 12, 18, 18, 6, 18, 6, 12, 6, 6]
const LINE = 22
const EDGE = 11

/**
 * Rows drawn at once.
 *
 * The list is filtered before it is capped, so this limits what is *rendered*,
 * never what is searchable: a query still matches the whole pool it was given.
 * Without it a caller that hands over a large pool renders a menu taller than
 * the window, and the menu scrolls inside itself instead.
 */
const MAX_ROWS_SHOWN = 60

const DEFAULT_EFFORTS = ['Low', 'Medium', 'High', 'Extra', 'Max']

export interface PromptBarSource {
  key: string
  name: string
  description?: string
  /** A Hugeicons icon element, or any node. */
  icon?: IconSvgElement | ReactNode
  /** True for the row that picks files rather than inserting a reference. */
  attach?: boolean
}

export interface PromptBarCommand {
  key: string
  /** With the leading slash, e.g. `/summarize`. */
  name: string
  description?: string
}

export interface PromptBarModel {
  key: string
  name: string
  tag?: string
}

export interface PromptBarSendMeta {
  attachments: string[]
  model: PromptBarModel | undefined
  effort: string
}

export interface PromptBarProps {
  placeholder?: string
  sources?: PromptBarSource[]
  commands?: PromptBarCommand[]
  models?: PromptBarModel[]
  /** Low to high. An empty list hides the control. */
  efforts?: string[]
  defaultEffort?: string
  onEffortChange?: (effort: string) => void
  defaultModel?: string
  /** A response is in flight: the tile stays ink and the arrow becomes a stop square. */
  busy?: boolean
  onSend?: (text: string, meta: PromptBarSendMeta) => void
  onStop?: () => void
  /** Return file names, or a promise of them, and they appear as chips. */
  onAttach?: () => string | string[] | Promise<string | string[]>
  /** Return the transcript, or a promise of it. Omit to hide the mic. */
  onDictate?: () => string | Promise<string>
  /** The field surface. */
  background?: string
  /** The ink: text, icons, and the armed tile. */
  color?: string
  /** The surface of the menus. */
  menuBackground?: string
  /** The wash, the sparks, and the slider at the top effort. */
  sparkColor?: string
  /** How strongly typing drives the sparks at the top effort. 0 keeps them calm. */
  sparkBoost?: number
  width?: number
  radius?: number
  /** Rows the field grows to before it scrolls. */
  maxRows?: number
  morphDuration?: number
  squash?: number
  tilt?: number
  pressScale?: number
  className?: string
}

type Row = PromptBarSource | PromptBarCommand | PromptBarModel
type OpenMenu = 'at' | 'slash' | 'model' | 'effort' | null

const mix = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * Interpolate two point lists into an SVG path.
 *
 * Both lists are the same length, so each pair of points is one vertex and the
 * morph is a straight-line move per vertex — which is why the transition holds
 * its shape instead of passing through a smear.
 */
const pathAt = (a: readonly number[], b: readonly number[], t: number): string => {
  let d = ''
  for (let i = 0; i < a.length; i += 2) {
    d += `${i ? 'L' : 'M'}${mix(a[i] as number, b[i] as number, t).toFixed(2)} ${mix(
      a[i + 1] as number,
      b[i + 1] as number,
      t
    ).toFixed(2)}`
  }
  return `${d}Z`
}

/** The `@` or `/` token immediately before the caret, if there is one. */
const parseToken = (draft: string): { kind: 'at' | 'slash'; query: string; start: number } | null => {
  const m = /(^|\s)([@/])([\w-]*)$/.exec(draft)
  if (!m) return null
  return {
    kind: m[2] === '@' ? 'at' : 'slash',
    query: (m[3] as string).toLowerCase(),
    start: m.index + (m[1] as string).length
  }
}

const renderIcon = (icon: IconSvgElement | ReactNode, size: number): ReactNode =>
  isValidElement(icon) ? icon : <HugeiconsIcon icon={icon as IconSvgElement} size={size} strokeWidth={1.8} />

const hasIcon = (row: Row): row is PromptBarSource => 'icon' in row
const hasTag = (row: Row): row is PromptBarModel => 'tag' in row
const hasDescription = (row: Row): row is PromptBarSource | PromptBarCommand => 'description' in row
const isAttach = (row: Row): boolean => 'attach' in row && row.attach === true

/**
 * The morph's easing, as a function rather than a bezier string.
 *
 * Driving the frames directly keeps the interpolation explicit — it starts from
 * wherever the glyph currently is, so a click during a morph reverses from the
 * current shape instead of snapping to one end first.
 */
const easeInOut = (k: number): number => {
  // Cubic-bezier(0.77, 0, 0.175, 1), sampled: a fast start and a soft landing.
  return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
}

function SendGlyph({
  busy,
  morphDuration,
  squash,
  tilt
}: {
  busy: boolean
  morphDuration: number
  squash: number
  tilt: number
}) {
  const reduce = useReducedMotion()
  const svgRef = useRef<SVGSVGElement>(null)
  const pathRef = useRef<SVGPathElement>(null)
  const dir = useRef(busy ? 1 : -1)
  /** Where the morph is now, 0 = arrow, 1 = square. */
  const at = useRef(busy ? 1 : 0)

  useEffect(() => {
    const target = busy ? 1 : 0
    dir.current = busy ? 1 : -1

    const paint = (v: number): void => {
      at.current = v
      pathRef.current?.setAttribute('d', pathAt(ARROW_UP, SQUARE, v))
      // The pinch keeps the glyph's area roughly constant mid-morph, which is
      // what stops it reading as a shape that dips in size on the way across.
      const goo = reduce ? 0 : Math.sin(v * Math.PI)
      const sx = 1 - squash * goo
      if (svgRef.current) {
        svgRef.current.style.transform = goo ? `rotate(${dir.current * tilt * goo}deg) scale(${sx}, ${1 / sx})` : ''
      }
    }

    if (reduce || morphDuration <= 0) {
      paint(target)
      return undefined
    }
    if (at.current === target) return undefined

    const from = at.current
    const startedAt = performance.now()
    let raf = requestAnimationFrame(function step(now) {
      const k = Math.min(1, (now - startedAt) / morphDuration)
      paint(from + (target - from) * easeInOut(k))
      if (k < 1) raf = requestAnimationFrame(step)
    })
    return () => cancelAnimationFrame(raf)
  }, [busy, morphDuration, reduce, squash, tilt])

  // Paint the resting shape on the first frame, before any morph has run.
  useEffect(() => {
    pathRef.current?.setAttribute('d', pathAt(ARROW_UP, SQUARE, at.current))
  }, [])

  return (
    <svg
      ref={svgRef}
      className="prompt-bar__glyph"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    >
      <path ref={pathRef} d={pathAt(ARROW_UP, SQUARE, at.current)} />
    </svg>
  )
}

export function PromptBar({
  placeholder = 'Ask anything',
  sources = [],
  commands = [],
  models = [],
  defaultModel = '',
  efforts = DEFAULT_EFFORTS,
  defaultEffort = '',
  onEffortChange,
  busy = false,
  onSend,
  onStop,
  onAttach,
  onDictate,
  background = 'var(--surface-2)',
  color = 'var(--text-1)',
  menuBackground = 'var(--surface-3)',
  sparkColor = 'var(--accent)',
  sparkBoost = 1,
  width = 400,
  radius = 16,
  maxRows = 5,
  morphDuration = 240,
  squash = 0.12,
  tilt = 8,
  pressScale = 0.96,
  className = ''
}: PromptBarProps) {
  const reduce = useReducedMotion()
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const glowRef = useRef<HTMLSpanElement>(null)
  const sparkRef = useRef<HTMLCanvasElement>(null)
  const typing = useRef({ energy: 0, strokes: 0 })
  const boost = useRef(sparkBoost)
  boost.current = sparkBoost
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([])
  const lastOpen = useRef<string | null>(null)
  const dictation = useRef(0)

  /**
   * Latest handlers, so the effects that run on a timer or a promise never close
   * over a stale prop. A send that fires a second after the last render must use
   * the handler from that render, not the one from when the effect was created.
   */
  const latest = useRef<{
    onSend?: PromptBarProps['onSend']
    onStop?: PromptBarProps['onStop']
    onAttach?: PromptBarProps['onAttach']
    onDictate?: PromptBarProps['onDictate']
    onEffortChange?: PromptBarProps['onEffortChange']
  }>({})
  latest.current = { onSend, onStop, onAttach, onDictate, onEffortChange }

  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<string[]>([])
  const [modelKey, setModelKey] = useState(defaultModel)
  const [plusOpen, setPlusOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [effortOpen, setEffortOpen] = useState(false)
  const [effortIndex, setEffortIndex] = useState(() => {
    const i = efforts.indexOf(defaultEffort)
    return i >= 0 ? i : Math.max(0, Math.floor((efforts.length - 1) / 2))
  })
  const [dismissed, setDismissed] = useState(false)
  const [active, setActive] = useState(0)
  const [listening, setListening] = useState(false)
  const [pressed, setPressed] = useState(false)

  const model: PromptBarModel | undefined = models.find((m) => m.key === modelKey) ?? models[0]
  const token = dismissed ? null : parseToken(draft)
  const open: OpenMenu = plusOpen ? 'at' : (token?.kind ?? (modelOpen ? 'model' : effortOpen ? 'effort' : null))
  const query = plusOpen ? '' : (token?.query ?? '')

  const list = useMemo<Row[]>(() => {
    if (open === 'at') return sources.filter((s) => s.name.toLowerCase().includes(query))
    if (open === 'slash') {
      return commands.filter((c) => c.name.replace(/^\//, '').toLowerCase().startsWith(query))
    }
    if (open === 'model') return models
    return []
  }, [open, query, sources, commands, models])

  const shown = useMemo(() => list.slice(0, MAX_ROWS_SHOWN), [list])
  const cursor = Math.min(active, Math.max(0, shown.length - 1))
  const canSend = draft.trim().length > 0 || attachments.length > 0
  const armed = busy || canSend
  const level = efforts[effortIndex] ?? ''
  const maxed = efforts.length > 1 && effortIndex === efforts.length - 1

  const focusInput = useCallback(() => inputRef.current?.focus({ preventScroll: true }), [])
  const closeMenus = useCallback(() => {
    setPlusOpen(false)
    setModelOpen(false)
    setEffortOpen(false)
  }, [])

  // The highlight is one element moved between rows rather than a class toggled
  // on each, which is what keeps it gliding instead of blinking.
  useLayoutEffect(() => {
    const glow = glowRef.current
    if (!glow || !open) return
    const row = rowRefs.current[cursor]
    if (!row) {
      glow.style.opacity = '0'
      return
    }
    // The menu scrolls once there are more rows than fit, so the highlight has
    // to be brought back into view when the keyboard walks past the edge.
    row.scrollIntoView({ block: 'nearest' })
    const fresh = lastOpen.current !== open
    lastOpen.current = open
    if (fresh) glow.style.transition = 'none'
    glow.style.top = `${row.offsetTop}px`
    glow.style.height = `${row.offsetHeight}px`
    glow.style.opacity = '1'
    if (fresh) {
      void glow.offsetHeight
      glow.style.transition = ''
    }
  }, [open, cursor, shown])

  useEffect(() => {
    if (!open) lastOpen.current = null
  }, [open])

  useEffect(() => {
    if (!plusOpen && !modelOpen && !effortOpen) return undefined
    const onDown = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) closeMenus()
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [plusOpen, modelOpen, effortOpen, closeMenus])

  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    // Collapsed first, or the box can only ever grow and never shrink.
    el.style.height = '0px'
    const max = LINE * maxRows
    el.style.height = `${Math.min(el.scrollHeight, max)}px`
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
  }, [draft, maxRows])

  useEffect(
    () => () => {
      // Bumping the sequence on unmount makes a late transcript resolve stale.
      dictation.current += 1
    },
    []
  )

  // Sparks, drawn only at the top effort. Everything scales with typing energy,
  // so the effect reads as a response to the user rather than an idle animation.
  useEffect(() => {
    const canvas = sparkRef.current
    if (!maxed || reduce || !canvas) return undefined
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined
    typing.current.strokes = 0
    let raf = 0
    let last = performance.now()
    let w = 0
    let h = 0
    let due = 0
    let speed = 1
    let pulse = 0
    const parts: {
      x: number
      y: number
      r: number
      vy: number
      sway: number
      phase: number
      life: number
      span: number
    }[] = []

    const resize = (): void => {
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      w = rect.width
      h = rect.height
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const spawn = (burst: boolean): void => {
      parts.push({
        x: Math.random() * w,
        y: burst ? h * (0.2 + Math.random() * 0.8) : h + 3,
        r: 0.9 + Math.random() * 1.1,
        vy: -(7 + Math.random() * 9),
        sway: (Math.random() - 0.5) * 10,
        phase: Math.random() * Math.PI * 2,
        life: burst ? Math.random() * 1.2 : 0,
        span: 2.4 + Math.random() * 2.4
      })
    }

    const tick = (now: number): void => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const typed = typing.current
      const gain = boost.current
      typed.energy *= Math.exp(-dt / 0.8)
      pulse *= Math.exp(-dt / 0.16)
      if (typed.strokes > 0) {
        typed.strokes = 0
        if (gain > 0) pulse = 1
      }
      const energy = typed.energy * gain
      speed += (1 + energy * 6 - speed) * (1 - Math.exp(-dt / 0.15))
      due += dt
      while (due > 0.14) {
        due -= 0.14
        if (parts.length < 30) spawn(false)
      }
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = sparkColor
      ctx.shadowColor = sparkColor
      ctx.shadowBlur = 6 + energy * 10 + pulse * 6
      for (let i = parts.length - 1; i >= 0; i -= 1) {
        const p = parts[i]
        if (!p) continue
        p.life += dt
        if (p.life > p.span) {
          parts.splice(i, 1)
          continue
        }
        const k = p.life / p.span
        const twinkle = 0.7 + 0.3 * Math.sin((now / 160) * (1 + energy) + p.phase)
        p.y += p.vy * dt * speed
        if (p.y < -4) {
          p.y = h + 3
          p.x = Math.random() * w
        }
        // Fade at both edges so sparks enter and leave rather than popping.
        const edge = Math.min(1, Math.max(0, p.y / 14), Math.max(0, (h - p.y) / 14))
        ctx.globalAlpha = Math.min(1, Math.sin(k * Math.PI) * (0.9 + energy * 0.25) * twinkle) * edge
        ctx.beginPath()
        ctx.arc(
          p.x + Math.sin((now / 900) * (1 + energy * 0.8) + p.phase) * p.sway,
          p.y,
          p.r * twinkle * (1 + energy * 0.35),
          0,
          Math.PI * 2
        )
        ctx.fill()
      }
      raf = requestAnimationFrame(tick)
    }

    resize()
    for (let i = 0; i < 26; i += 1) spawn(true)
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      ctx.clearRect(0, 0, w, h)
    }
  }, [maxed, reduce, sparkColor])

  const setEffort = (i: number): void => {
    const next = Math.max(0, Math.min(efforts.length - 1, i))
    if (next === effortIndex) return
    setEffortIndex(next)
    latest.current.onEffortChange?.(efforts[next] as string)
  }

  const effortFromPointer = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const k = (e.clientX - rect.left - EDGE) / Math.max(1, rect.width - 2 * EDGE)
    setEffort(Math.round(k * (efforts.length - 1)))
  }

  const onEffortKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0
    if (step) {
      e.preventDefault()
      setEffort(effortIndex + step)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setEffort(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setEffort(efforts.length - 1)
    } else if (e.key === 'Escape') {
      setEffortOpen(false)
      focusInput()
    }
  }

  const stepAt = (i: number): string => `calc(${EDGE}px + (100% - ${EDGE * 2}px) * ${i / Math.max(1, efforts.length - 1)})`
  const fillAt = (i: number): string => (i === efforts.length - 1 ? '100%' : `calc(${stepAt(i)} + 7px)`)

  const pick = (row: Row): void => {
    if (open === 'model' && hasTag(row)) {
      setModelKey(row.key)
      setModelOpen(false)
      focusInput()
      return
    }
    const head = token ? draft.slice(0, token.start) : draft
    if (isAttach(row)) {
      setDraft(head)
      void Promise.resolve(latest.current.onAttach?.()).then((files) => {
        if (!files) return
        setAttachments((a) => [...a, ...(Array.isArray(files) ? files : [files])])
      })
    } else if (open === 'at') {
      setDraft(`${head}@${row.name} `)
    } else {
      setDraft(`${head}${row.name} `)
    }
    setPlusOpen(false)
    setDismissed(false)
    focusInput()
  }

  const send = (): void => {
    if (!canSend || busy) return
    latest.current.onSend?.(draft.trim(), { attachments, model, effort: level })
    setDraft('')
    setAttachments([])
    setDismissed(false)
    closeMenus()
    focusInput()
  }

  const toggleListen = (): void => {
    if (listening) {
      dictation.current += 1
      setListening(false)
      return
    }
    const seq = ++dictation.current
    setListening(true)
    void Promise.resolve(latest.current.onDictate?.()).then(
      (text) => {
        if (seq !== dictation.current) return
        setListening(false)
        if (text) setDraft((d) => (d.trim() ? `${d.trimEnd()} ${text}` : text))
        focusInput()
      },
      () => {
        if (seq === dictation.current) setListening(false)
      }
    )
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (open && shown.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((cursor + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length)
        return
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault()
        pick(shown[cursor] as Row)
        return
      }
    }
    if (e.key === 'Escape') {
      if (open) {
        e.preventDefault()
        setDismissed(true)
        closeMenus()
      }
      return
    }
    // Enter sends, Shift+Enter breaks the line, and an IME composition owns
    // Enter until it is done — otherwise picking a candidate submits the prompt.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  const down = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (e.button !== 0 || !armed) return
    setPressed(true)
  }
  const up = (): void => setPressed(false)

  return (
    <div
      ref={rootRef}
      className={`prompt-bar${className ? ` ${className}` : ''}`}
      data-busy={busy ? '' : undefined}
      data-max={maxed ? '' : undefined}
      style={
        {
          '--pb-bg': background,
          '--pb-ink': color,
          '--pb-menu': menuBackground,
          '--pb-w': `${width}px`,
          '--pb-radius': `${radius}px`,
          '--pb-spark': sparkColor,
          '--pb-press': pressScale
        } as CSSProperties
      }
    >
      {open ? (
        <div
          className="prompt-bar__menu"
          role={open === 'effort' ? 'dialog' : 'listbox'}
          aria-label={open === 'at' ? 'Sources' : open === 'slash' ? 'Commands' : open === 'model' ? 'Models' : 'Effort'}
          data-kind={open}
        >
          {open === 'effort' ? (
            <>
              <div className="prompt-bar__effort-head">
                <span className="prompt-bar__effort-title">Effort</span>
                <span className="prompt-bar__effort-level">{level}</span>
                <span className="prompt-bar__effort-help" title="Higher effort thinks longer before answering">
                  <HugeiconsIcon icon={HelpCircleIcon} size={14} strokeWidth={1.8} />
                </span>
              </div>
              <div className="prompt-bar__effort-ends">
                <span>Faster</span>
                <span>Smarter</span>
              </div>
              <div
                className="prompt-bar__effort-track"
                role="slider"
                tabIndex={0}
                aria-label="Effort"
                aria-valuemin={0}
                aria-valuemax={efforts.length - 1}
                aria-valuenow={effortIndex}
                aria-valuetext={level}
                style={
                  {
                    '--pb-effort-x': stepAt(effortIndex),
                    '--pb-effort-fill': fillAt(effortIndex)
                  } as CSSProperties
                }
                onPointerDown={(e) => {
                  if (e.button !== 0) return
                  try {
                    e.currentTarget.setPointerCapture(e.pointerId)
                  } catch {
                    // Pointer capture is an optimisation, not a requirement.
                  }
                  e.currentTarget.focus({ preventScroll: true })
                  effortFromPointer(e)
                }}
                onPointerMove={(e) => {
                  if (e.buttons & 1) effortFromPointer(e)
                }}
                onKeyDown={onEffortKey}
              >
                <span className="prompt-bar__effort-fill" />
                {efforts.map((label, i) => (
                  <i key={label} className="prompt-bar__effort-dot" style={{ left: stepAt(i) }} />
                ))}
                <span className="prompt-bar__effort-thumb" />
              </div>
            </>
          ) : (
            <>
              <span ref={glowRef} className="prompt-bar__glow" aria-hidden="true" />
              {shown.map((row, i) => (
                <button
                  key={row.key}
                  ref={(el) => {
                    rowRefs.current[i] = el
                  }}
                  type="button"
                  role="option"
                  aria-selected={i === cursor}
                  className="prompt-bar__row"
                  onMouseDown={(e) => e.preventDefault()}
                  onPointerEnter={() => setActive(i)}
                  onClick={() => pick(row)}
                >
                  {open === 'at' && hasIcon(row) ? (
                    <span className="prompt-bar__row-icon">{renderIcon(row.icon, 15)}</span>
                  ) : null}
                  <span className="prompt-bar__row-name">{row.name}</span>
                  {hasDescription(row) && row.description ? (
                    <span className="prompt-bar__row-desc">{row.description}</span>
                  ) : null}
                  {open === 'model' && hasTag(row) ? (
                    <>
                      <span className="prompt-bar__row-tag">{row.tag}</span>
                      <span className="prompt-bar__row-check" data-on={row.key === model?.key ? '' : undefined}>
                        <HugeiconsIcon icon={Tick02Icon} size={13} strokeWidth={2.5} />
                      </span>
                    </>
                  ) : null}
                </button>
              ))}
              {shown.length === 0 ? <div className="prompt-bar__empty">No matches for “{query}”</div> : null}
            </>
          )}
        </div>
      ) : null}

      <div
        className="prompt-bar__field"
        role="presentation"
        data-max={maxed ? '' : undefined}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget || e.target === inputRef.current) closeMenus()
        }}
        onClick={focusInput}
      >
        <canvas ref={sparkRef} className="prompt-bar__sparks" aria-hidden="true" />
        {attachments.length > 0 ? (
          <div className="prompt-bar__chips">
            {attachments.map((file, i) => (
              <span key={`${file}-${i}`} className="prompt-bar__chip">
                <HugeiconsIcon icon={File02Icon} size={12} strokeWidth={2} />
                <span className="prompt-bar__chip-name">{file}</span>
                <button
                  type="button"
                  className="prompt-bar__chip-x"
                  aria-label={`Remove ${file}`}
                  onClick={() => setAttachments((a) => a.filter((_, j) => j !== i))}
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2.5} />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <textarea
          ref={inputRef}
          className="prompt-bar__input"
          rows={1}
          value={draft}
          placeholder={listening ? 'Listening…' : placeholder}
          aria-label="Prompt"
          onChange={(e) => {
            setDraft(e.target.value)
            typing.current.energy = Math.min(1.6, typing.current.energy + 0.22)
            typing.current.strokes = Math.min(4, typing.current.strokes + 1)
            setDismissed(false)
            closeMenus()
            setActive(0)
          }}
          onFocus={closeMenus}
          onKeyDown={onKeyDown}
        />

        <div className="prompt-bar__bar">
          <button
            type="button"
            className="prompt-bar__tool"
            aria-label="Add files and sources"
            aria-expanded={plusOpen}
            data-on={plusOpen ? '' : undefined}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setModelOpen(false)
              setEffortOpen(false)
              setActive(0)
              setPlusOpen((v) => !v)
              focusInput()
            }}
          >
            <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={2} />
          </button>
          {models.length > 0 ? (
            <button
              type="button"
              className="prompt-bar__pick"
              aria-label="Choose model"
              aria-expanded={modelOpen}
              data-on={modelOpen ? '' : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setPlusOpen(false)
                setEffortOpen(false)
                setActive(Math.max(0, model ? models.indexOf(model) : 0))
                setModelOpen((v) => !v)
                focusInput()
              }}
            >
              <span>{model?.name}</span>
              <HugeiconsIcon icon={ArrowDown01Icon} size={12} strokeWidth={2.4} />
            </button>
          ) : null}
          {efforts.length > 0 ? (
            <button
              type="button"
              className="prompt-bar__pick"
              aria-label="Choose effort"
              aria-expanded={effortOpen}
              data-on={effortOpen ? '' : undefined}
              data-max={maxed ? '' : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setPlusOpen(false)
                setModelOpen(false)
                setEffortOpen((v) => !v)
                focusInput()
              }}
            >
              <HugeiconsIcon icon={SparklesIcon} size={13} strokeWidth={2} />
              <span>{level}</span>
            </button>
          ) : null}
          <span className="prompt-bar__spacer" />
          {onDictate ? (
            <button
              type="button"
              className="prompt-bar__tool"
              aria-label={listening ? 'Stop dictation' : 'Dictate'}
              aria-pressed={listening}
              data-on={listening ? '' : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={toggleListen}
            >
              {listening ? (
                <span className="prompt-bar__eq" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              ) : (
                <HugeiconsIcon icon={Mic01Icon} size={15} strokeWidth={2} />
              )}
            </button>
          ) : null}
          <button
            type="button"
            className="prompt-bar__send"
            disabled={!armed}
            aria-label={busy ? 'Stop' : 'Send'}
            data-armed={armed ? '' : undefined}
            data-pressed={pressed ? '' : undefined}
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={down}
            onPointerUp={up}
            onPointerCancel={up}
            onPointerLeave={up}
            onClick={() => {
              if (busy) latest.current.onStop?.()
              else send()
            }}
          >
            <SendGlyph busy={busy} morphDuration={morphDuration} squash={squash} tilt={tilt} />
          </button>
        </div>
      </div>
    </div>
  )
}

/** The default source rows the upstream component ships, for callers that want them. */
export const DEFAULT_SOURCES: PromptBarSource[] = [
  {
    key: 'files',
    name: 'Photos & files',
    description: 'Upload from this device',
    icon: Attachment01Icon,
    attach: true
  },
  { key: 'web', name: 'Web search', description: 'Live results', icon: Globe02Icon },
  { key: 'sales', name: 'Sales data', description: 'Revenue and churn', icon: ChartLineData01Icon },
  { key: 'docs', name: 'Documents', description: 'Specs, notes, briefs', icon: File02Icon },
  { key: 'mail', name: 'Mail', description: 'Read and draft mail', icon: Mail01Icon },
  { key: 'calendar', name: 'Calendar', description: 'Events and availability', icon: Calendar03Icon }
]
