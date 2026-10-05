/**
 * A conversation that lives in more than one place.
 *
 * The user can choose to keep chat history in the app's own folder, in the
 * project's `.cryptoricagent/`, or in both. "Both" is the interesting case: two
 * files have to agree, or a user who copies the folder to a colleague gets half
 * a conversation.
 *
 * The rule is **write to every target, read from the first that has anything.**
 * Reading from the first non-empty copy rather than merging them means there is
 * never a duplicate turn: a turn written to both files is one turn, not two
 * concatenated with itself.
 *
 * A target that fails to write is skipped, not fatal. A project on a read-only
 * mount should still have history in the app folder, which is exactly why
 * there are two places to write.
 */

import { ConversationStore } from './conversation'
import type { ConversationTurn } from '@shared/types'

export interface MirrorResult {
  written: string[]
  /** Targets that could not be written, with the reason. */
  failed: { path: string; error: string }[]
}

export class MirroredConversation {
  private stores: ConversationStore[]
  private currentScope: string | null = null

  constructor(paths: readonly string[]) {
    this.stores = paths.map((p) => new ConversationStore(p))
  }

  /**
   * Point the conversation at a different set of files.
   *
   * Called when a project is opened, because the target path depends on the
   * project's own id and the user's storage setting. The in-memory turns of the
   * previous project are dropped on purpose: the new project's history is what
   * belongs in this conversation, and keeping the old one would show project A's
   * transcript while working in project B.
   */
  retarget(paths: readonly string[]): void {
    this.stores = paths.filter((p) => p.length > 0).map((p) => new ConversationStore(p))
    if (this.currentScope !== null) {
      for (const store of this.stores) store.setProject(this.currentScope)
    }
  }

  get size(): number {
    return this.stores.length
  }

  setProject(projectRoot: string | null): void {
    this.currentScope = projectRoot
    for (const store of this.stores) store.setProject(projectRoot)
  }

  get scope(): string {
    return this.primary().scope
  }

  /**
   * Identifier of the conversation currently in view.
   *
   * Read from the same copy reads come from, so the id shown in the UI always
   * belongs to the transcript actually on screen.
   */
  get conversationId(): string {
    return this.primary().conversationId
  }

  /**
   * The store reads come from.
   *
   * Chosen once per read by looking for a copy that actually holds turns,
   * because after a settings change the two files can briefly differ — one was
   * written while the other was unwritable.
   */
  private primary(): ConversationStore {
    const withTurns = this.stores.find((s) => s.all().length > 0)
    return withTurns ?? this.stores[0] ?? new ConversationStore('')
  }

  append(turn: Omit<ConversationTurn, 'id' | 'at'> & { at?: string }): ConversationTurn {
    // Always append to every copy through the primary, then copy the resulting
    // entry to the rest by value. Round-tripping through `append` would let each
    // store mint its own id, and the two files would disagree about what a turn
    // is.
    const stored = this.primary().append(turn)
    for (const store of this.stores) {
      if (store === this.primary()) continue
      store.append(stored)
    }
    return stored
  }

  appendUser(text: string): ConversationTurn {
    return this.append({ role: 'user', text })
  }

  appendAssistant(text: string): ConversationTurn {
    return this.append({ role: 'assistant', text })
  }

  appendTool(tool: string, text: string, ok: boolean): ConversationTurn {
    return this.append({ role: 'tool', text, tool, ok })
  }

  all(): ConversationTurn[] {
    return this.primary().all()
  }

  contextMessages(limit?: number): { role: 'user' | 'assistant'; content: string }[] {
    return limit === undefined ? this.primary().contextMessages() : this.primary().contextMessages(limit)
  }

  scopesWithHistory(): string[] {
    return this.primary().scopesWithHistory()
  }

  clear(): ConversationTurn[] {
    for (const store of this.stores) store.clear()
    return this.primary().all()
  }

  /**
   * Wait until every copy is on disk.
   *
   * `ConversationStore` writes on a queued promise, so an append that has
   * returned is *not* yet durable. Without this a CLI process that exits right
   * after a run — which is exactly what `cryptoric run` does — could drop the
   * last turn, and the failure would look like the history never existed.
   */
  async flush(): Promise<void> {
    await Promise.all(this.stores.map((store) => store.flush()))
  }
}