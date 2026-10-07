/**
 * The prompt bar, wired to this app.
 *
 * `PromptBar` is presentational: it knows how to render menus and animate a
 * glyph, and nothing about where its rows come from. This component is the other
 * half — it fills the three menus with things that exist, because a menu row that
 * does nothing is worse than no menu:
 *
 *  - **sources** are the *files in the open project*, fetched from the same
 *    `file.search` the Files pane uses. Picking one inserts `@relative/path`,
 *    which is a reference the model can actually follow, instead of asking the
 *    user to remember and type a path.
 *  - **commands** are the project's *enabled skills*, which is what the agent
 *    already routes on: a prompt beginning `/name` selects a skill. The menu
 *    therefore offers exactly the commands that will work.
 *  - **models** are the app's real models. The bar has no way to switch one by
 *    itself, so the choice is applied on send — the model named on the tile is
 *    the model the task runs on, which is the only version of this control that
 *    is not a lie.
 *
 * The **effort slider is deliberately not enabled**: this app has no effort or
 * reasoning-budget setting, so `efforts` is empty and the control hides itself.
 * The same reasoning hides the microphone, because there is no dictation backend
 * to call.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FileSearchHit, ProjectProfile, SkillDescriptor } from '@shared/types'
import { File02Icon } from '@hugeicons/core-free-icons'
import {
  PromptBar,
  type PromptBarCommand,
  type PromptBarModel,
  type PromptBarSendMeta,
  type PromptBarSource
} from './PromptBar'

/**
 * Files the `@` menu can match against.
 *
 * This is a *pool to filter*, not a list to display: the menu narrows it as you
 * type and draws at most a screenful, so a small pool is the whole problem —
 * with thirty files, `@Home` finds nothing on a repo with three hundred. The
 * search is cheap at this size because an empty query matches on the name and
 * never opens a file, so this walks directories and stops there.
 */
const MAX_FILE_ROWS = 400

export interface AgentPromptBarProps {
  /** The open project, or null. Without one there are no files to reference. */
  project: ProjectProfile | null
  models: { id: string; label: string; kind: string; active: boolean }[]
  onSelectModel: (id: string) => void
  /** A task is in flight: the tile becomes the stop control. */
  busy: boolean
  onSubmit: (prompt: string) => void
  onStop?: () => void
  placeholder?: string
  width?: number
  maxRows?: number
  className?: string
}

/** A path relative to the project root, in the separators the agent is used to. */
function relativeTo(root: string, target: string): string {
  const normalRoot = root.replace(/[\\/]+$/, '')
  const rel = target.startsWith(normalRoot) ? target.slice(normalRoot.length) : target
  return rel.replace(/^[\\/]+/, '').split('\\').join('/')
}

function directoryOf(relativePath: string): string {
  const cut = relativePath.lastIndexOf('/')
  return cut > 0 ? relativePath.slice(0, cut) : ''
}

export function AgentPromptBar({
  project,
  models,
  onSelectModel,
  busy,
  onSubmit,
  onStop,
  placeholder = 'Describe what you want to build — paste code, logs or a whole file straight in.',
  width = 760,
  maxRows = 6,
  className
}: AgentPromptBarProps) {
  const root = project?.root ?? null
  const [files, setFiles] = useState<PromptBarSource[]>([])
  const [commands, setCommands] = useState<PromptBarCommand[]>([])

  // Skills are process-wide, so they are read once rather than per project.
  useEffect(() => {
    let live = true
    void window.cryptoric?.skill
      .list()
      .then((skills: SkillDescriptor[]) => {
        if (!live) return
        setCommands(
          skills
            .filter((s) => s.enabled)
            .map((s) => ({ key: s.id, name: `/${s.name}`, description: s.description }))
        )
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

  // Files belong to a project, so this reloads whenever the project changes —
  // including back to "none", which must empty the menu rather than leave the
  // previous project's paths offerable.
  useEffect(() => {
    let live = true
    if (!root) {
      setFiles([])
      return () => {
        live = false
      }
    }
    void window.cryptoric?.file
      .search('', MAX_FILE_ROWS)
      .then((hits: FileSearchHit[]) => {
        if (!live) return
        setFiles(
          hits.map((hit) => {
            const relative = relativeTo(root, hit.path)
            return {
              key: hit.path,
              name: relative,
              description: directoryOf(relative),
              icon: File02Icon
            }
          })
        )
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [root])

  const modelRows = useMemo<PromptBarModel[]>(
    () =>
      models.map((m) => ({
        key: m.id,
        name: m.label,
        tag: m.kind === 'local' ? 'Local' : 'Hosted'
      })),
    [models]
  )
  const activeModelId = models.find((m) => m.active)?.id ?? ''

  const handleSend = useCallback(
    (text: string, meta: PromptBarSendMeta) => {
      // Applied before the task starts, so the model named on the tile is the
      // model that runs it.
      if (meta.model && meta.model.key !== activeModelId) onSelectModel(meta.model.key)
      onSubmit(text)
    },
    [activeModelId, onSelectModel, onSubmit]
  )

  return (
    <PromptBar
      className={className}
      placeholder={placeholder}
      sources={files}
      commands={commands}
      models={modelRows}
      defaultModel={activeModelId}
      efforts={[]}
      busy={busy}
      onSend={handleSend}
      {...(onStop ? { onStop } : {})}
      width={width}
      maxRows={maxRows}
    />
  )
}
