# Cryptoric Agent — Design System & Visual Direction

> Source of truth for the renderer UI. Defined **before** component code, per the
> anti-ai-slop-ui mandatory process (classify → context → direction → tokens →
> layout → anti-slop check → implement → verify).

---

## 1. Task classification

**Primary type:** desktop application screen (multi-pane developer workbench).
**Secondary:** dense operational dashboard (environment, tasks, processes, ports).

This is **not** a landing page. There is no marketing surface in this product.
The first pixel a user sees is live workbench state.

## 2. Product context

| Question | Answer |
|---|---|
| Product type | AI-native desktop development environment ("AI developer operating system") |
| Target user | Working developers who live in a terminal and an editor simultaneously |
| Primary action | Direct an agent and watch it operate across files, processes and runtimes |
| Platform | Windows-first desktop (Electron), macOS/Linux supported |
| Density | High. Information-efficiency is a feature, not a defect. |
| Trust requirement | Very high — the agent executes commands and installs runtimes on the user's machine |
| Emotional tone | Calm, instrumented, verifiable. Serious without being cold. |
| Accessibility | WCAG AA contrast on all text, full keyboard operation, reduced-motion respected |

Trust is the governing constraint: **every autonomous action must be legible.**
If the user cannot see what the agent did, why it did it, and whether it
succeeded, the design has failed regardless of how it looks.

## 3. Visual direction: **"Instrument Console"**

A deliberate synthesis of two skill-library directions, with a third quality
borrowed from archival records:

- **Developer Tool / CLI Companion** — sharp, technical, legible, dense, credible.
- **Security Operations Console** — precise, evidence-first, red reserved for true alerts.
- **Research Archive** (ledger quality) — hairline-separated data rows instead of
  card stacks; values are recorded, not decorated.

### Why not the obvious directions

- Not "Native macOS Utility" — the product is cross-platform and its differentiator
  is *operational depth*, which macOS chrome would visually soften away.
- Not "Crypto Intelligence Terminal" — neon/cyberpunk cues would misrepresent a
  tool that mostly shows terminals, diffs and version numbers.
- Not "Enterprise Control Plane" — too generic; every observability console claims it.

### The three governing ideas

1. **The ledger, not the dashboard.** Data appears in hairline-separated rows with
   an explicit `LABEL · VALUE · META` rhythm. Cards are used only where an object
   genuinely needs containment.
2. **Measured scale.** A vertical spine with tick marks anchors navigation and the
   task timeline. The UI should feel calibrated, like an instrument, not like a poster.
3. **State is the accent.** There is exactly one accent (sulfur). Everything
   chromatic is *semantic*: verdigris = verified, ember = failed, coldsteel = neutral
   information. Decoration is never chromatic.

### Anti-slop commitments

| Rejected default | Cryptoric's answer |
|---|---|
| Purple/indigo AI palette | Sulfur `#D8A13A` on graphite. No purple anywhere. |
| Purple/blue glow, glassmorphism | Zero `box-shadow` glow, zero `backdrop-filter` bloom. Depth is expressed with a 1px hairline + surface step. |
| Gradient hero text | No hero. No display font above 19px in the app shell. |
| Hero + three cards + CTA | Workbench-first layout; asymmetric 4-lane grid. |
| Rounded-3xl cards everywhere | Radius scale tops out at **3px**. Tool UIs want density. |
| Emoji as icons | No emoji in the product. Glyph set is custom SVG marks + JetBrains Mono symbols. |
| Inter / Geist by default | Instrument Sans Variable + JetBrains Mono Variable, bundled locally so the app works offline. |
| Decorative motion | Motion is bound to state changes only (see §6). |
| Fake terminal / fake activity | Every terminal, process and browser surface shows **real** output from real processes. |

## 4. Design tokens

Full machine-readable source: [`src/renderer/src/styles/tokens.css`](src/renderer/src/styles/tokens.css).

### 4.1 Color — "Graphite & Sulfur" (dark, default)

| Token | Value | Use |
|---|---|---|
| `--surface-void` | `#0A0B0D` | Window background, behind everything |
| `--surface-sunken` | `#070809` | Terminal gutter, code wells |
| `--surface-base` | `#0F1114` | Panel background |
| `--surface-raised` | `#15181C` | Raised rows, inputs, hover surfaces |
| `--surface-overlay` | `#1B1F24` | Popovers, command palette |
| `--hairline` | `rgba(233,231,224,0.075)` | All 1px dividers and borders |
| `--hairline-strong` | `rgba(233,231,224,0.14)` | Active/emphasised dividers |
| `--ink-primary` | `#E6E4DD` | Body text (bone, never `#FFF`) |
| `--ink-secondary` | `#9B9E9F` | Labels, secondary data |
| `--ink-tertiary` | `#63676A` | Micro-labels, disabled, ticks |
| `--accent-sulfur` | `#D8A13A` | Primary action, active agent state |
| `--signal-verdigris` | `#4FA795` | Verified, healthy, completed |
| `--alert-ember` | `#D0563F` | Failure, destructive, blocked |
| `--info-coldsteel` | `#7194AC` | Neutral information, in-progress |
| `--diff-add` / `--diff-del` | `#3F8F63` / `#A8503F` | Diff gutters |

Derived: `--accent-sulfur-dim`, `--accent-sulfur-glow-*` are **not** used; the
accent is only ever used as a flat fill or 1px stroke.

### 4.2 Light theme — "Bone Ledger"

Warm archival paper: `--surface-void #F2EFE8`, ink `#1A1A18`, same semantic hues
darkened for AA contrast. Provided because a developer tool that is only usable in
one appearance is a preference, not a design system.

### 4.3 Typography

| Role | Face | Size / weight | Notes |
|---|---|---|---|
| Micro-label | JetBrains Mono | 10px / 500, `0.09em` tracking, uppercase | Used for every section header and column head |
| Data / command | JetBrains Mono | 12px / 400 | Versions, paths, exit codes, diff, terminal, logs |
| UI body | Instrument Sans | 12.5px / 400 | Prose, buttons, tabs |
| UI body strong | Instrument Sans | 12.5px / 600 | Labels that must win |
| Section title | Instrument Sans | 15px / 600 | Pane titles only |
| Emphasis (max) | Instrument Sans | 19px / 600 | Workspace/project name. Hard ceiling. |

Ratio is tight and integer-ish because it is an instrument panel, not a page.
Line height `1.45` for prose, `1.5` for mono data.

### 4.4 Spacing, radius, elevation

- Base grid **4px**; allowed steps `2, 4, 8, 12, 16, 20, 24, 32`.
- Density modes: `compact` (row height 24px), `default` (28px), `relaxed` (34px).
- Radius: `--radius-xs 2px`, `--radius-sm 3px`, `--radius-md 4px` (modals only).
  **No pill buttons anywhere.** Status chips are square-cornered with a leading mark.
- Elevation: surface step + hairline only. Shadows reserved for true overlays
  (`0 12px 32px rgba(0,0,0,0.55)`) — never for cards.
- Hairline borders everywhere; **no borderless floating panels**, because in a
  dense console, un-bordered regions read as broken rather than clean.

### 4.5 Iconography

Custom 16px stroke glyphs on a 16px grid, `stroke-width: 1.25`, square caps.
Built in-house for the marks that carry identity (`Seal`, `Spine`, `StatusBar`);
generic glyphs (folder, gear, chevron) are hand-drawn to the same grid so the set
is visually consistent. **No third-party icon set**, **no emoji**.

## 5. Layout strategy

**Pattern: asymmetric command center + dense ledger.**

```
┌──┬────────────┬───────────────────────────────┬──────────────┬────────┐
│S │            │  AGENT TRANSCRIPT            │              │        │
│P │  NAV       │  (messages, tool calls,      │  INSPECTOR   │        │
│I │  (project  │   reasoning, approvals)      │  files /     │        │
│N │   list,    ├───────────────────────────────┤  changes /   │        │
│E │   modes)   │  CODE / DIFF / BROWSER        │  context /   │        │
│  │            │  (tabbed working surface)     │  tools /     │        │
│28│   224      ├───────────────────────────────┤  environment │  320   │
│px│   resizable├───────────────────────────────┤              │ resiz. │
│  │            │  DOCK: terminal · logs ·     │              │        │
│  │            │  tasks · ports               │              │        │
└──┴────────────┴───────────────────────────────┴──────────────┴────────┘
```

- Every boundary is a draggable splitter (1px hairline, 6px hit area) with
  double-click-to-reset and collapse-to-zero.
- Center column splits **horizontally** (transcript over working surface), so a
  developer sees cause (what the agent said) and effect (what it changed) at once.
- The bottom dock is a real terminal + log multiplexer, not a decorative console.
- Layout is persisted per project and restored on relaunch.

**Signature components** (the things that make this recognizable as Cryptoric):

1. `SealMark` — engraved bracket-and-dot glyph, state-coloured. Replaces the
   generic app icon in the spine, the running-task list, and the activity header.
2. `SpineRail` — vertical measure with 4px ticks; carries workspace state and the
   timeline. The single most identifiable element.
3. `LedgerRow` — `LABEL · VALUE · META` hairline row used for environment, settings
   and diagnostics. Deliberately *not* a card.
4. `StatusBar3` — three-segment square glyph (▮▮▯) for tri-state rows such as
   running/queued/idle. No rounded pills.

## 6. Motion language

Motion communicates system state. Nothing else moves.

| Trigger | Motion | Duration |
|---|---|---|
| Hover / press on controls | background + border step | 90ms `ease-out` |
| Panel collapse / dock toggle | height + opacity | 160ms `cubic-bezier(.2,.8,.2,1)` |
| Command palette | overlay fade + 4px rise | 120ms |
| Agent running | `SealMark` opacity step 0.45↔1 | 1600ms loop, **only while running** |
| Tool running | one 1px highlight travels down the timeline spine | duration = tool duration |
| Tool finished | row settles, status colour transitions to semantic | 140ms |
| Install progress | determinate bar fills monotonically | real progress, no easing |
| Terminal output | appended as received, no animation | 0ms |
| Destructive confirmation | 2-step inline arm, no modal theatre | 120ms |

- Nothing loops idly. The app is completely still when idle.
- `@media (prefers-reduced-motion: reduce)` → all durations collapse to `0.01ms`,
  the agent pulse becomes a static filled mark, progress bars keep updating
  (they convey data, not decoration).

## 7. Anti-slop gate (self-assessment)

| Check | Result |
|---|---|
| Default shadcn demo look? | **No** — no Card/Header/Content rhythm, no slate palette, custom radius scale |
| Main accent purple/indigo? | **No** — sulfur |
| Gradient hero headline? | **No** — no hero exists |
| Hero + three cards + CTA? | **No** — workbench grid |
| Emoji as icons? | **No** — custom SVG marks |
| Everything heavily rounded? | **No** — max radius 4px |
| Glow / aurora / blob / glassmorphism? | **No** — zero blur filters |
| Inter/Geist as unexamined default? | **No** — Instrument Sans + JetBrains Mono, chosen for a technical, non-SaaS tone and bundled for offline use |
| Excessive hover/scroll animation? | **No** — motion table above |
| Indistinguishable from Cursor/VS Code/Claude? | **No** — spine rail, ledger rows, three-segment status, and the sulfur/graphite palette are specific to Cryptoric |

**AI Slop Score: 1 / 10** (proceed)
**Distinctiveness Score: 8 / 10** — strong and coherent. Residual genericness is
limited to the center working surface, which inherits familiar tabbed-editor
affordances; that is intentional ergonomics, not a default.

### Known trade-offs

- The spine consumes 28px of width. Accepted: it carries persistent state for every
  project and is the primary identity anchor.
- Bone-light theme has less contrast headroom than the dark theme for hairline
  dividers. Mitigated by raising hairline opacity in the light token block.
- Monospace-everywhere-for-data reduces scan speed for prose. Mitigated by keeping
  all prose in Instrument Sans and reserving mono strictly for machine facts.