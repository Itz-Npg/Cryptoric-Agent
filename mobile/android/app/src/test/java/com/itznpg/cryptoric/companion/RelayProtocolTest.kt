package com.itznpg.cryptoric.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Android half of the relay contract.
 *
 * Same cases as `mobile/relay/test/protocol.test.js`. If the two suites ever
 * disagree, one of them is describing a protocol the other no longer speaks,
 * and the phone shows an empty list rather than an error.
 */
class RelayProtocolTest {

    @Test
    fun `decodes a task off the wire`() {
        val snapshot = RelayProtocol.decodeSnapshot(
            """
            {"tasks":[
              {"id":"t1","title":"Build a thing","status":"implementing","stage":"IMPLEMENTING",
               "lastNote":"writing","updatedAt":"2026-10-05T10:00:00.000Z","changedPaths":["a.ts","b.ts"]}
            ]}
            """.trimIndent()
        )

        assertEquals(1, snapshot.tasks.size)
        val task = snapshot.tasks.first()
        assertEquals("t1", task.id)
        assertEquals("Build a thing", task.title)
        assertEquals("implementing", task.status)
        assertEquals(listOf("a.ts", "b.ts"), task.changedPaths)
    }

    @Test
    fun `an unknown status becomes blocked, never completed`() {
        // A newer desktop reporting a status this build has not heard of must
        // not be shown to the user as a success.
        val snapshot = RelayProtocol.decodeSnapshot("""{"tasks":[{"id":"t1","status":"teleporting"}]}""")
        assertEquals("blocked", snapshot.tasks.first().status)
        assertFalse(RelayProtocol.isSuccess(snapshot.tasks.first().status))
    }

    @Test
    fun `missing fields become empty rather than invented`() {
        val snapshot = RelayProtocol.decodeSnapshot("""{"tasks":[{"id":"t1"}]}""")
        val task = snapshot.tasks.first()
        assertEquals("", task.title)
        assertEquals(RelayProtocol.UNKNOWN_STATUS, task.status)
        assertEquals(emptyList<String>(), task.changedPaths)
    }

    @Test
    fun `a failed or blocked task needs attention`() {
        val snapshot = RelayProtocol.decodeSnapshot(
            """{"tasks":[
              {"id":"a","status":"failed"},{"id":"b","status":"blocked"},
              {"id":"c","status":"completed"},{"id":"d","status":"implementing"}
            ]}""".trimIndent()
        )
        assertEquals(listOf("a", "b"), snapshot.tasks.filter { it.needsAttention }.map { it.id })
        assertEquals(listOf("a", "b", "c"), snapshot.finished.map { it.id })
        assertEquals(listOf("d"), snapshot.active.map { it.id })
    }

    @Test
    fun `a message that is not a snapshot reports the error instead of throwing`() {
        // A phone that crashes because the desktop sent something new is worse
        // than one that says it could not read the last update.
        val snapshot = RelayProtocol.decodeSnapshot("not json at all")
        assertTrue(snapshot.tasks.isEmpty())
        assertTrue(snapshot.error!!.contains("Could not read"))
    }

    @Test
    fun `an empty task list is a valid message`() {
        val snapshot = RelayProtocol.decodeSnapshot("""{"tasks":[]}""")
        assertTrue(snapshot.tasks.isEmpty())
        assertTrue(snapshot.error == null)
    }

    @Test
    fun `terminal statuses are the four that stop`() {
        assertTrue(RelayProtocol.isTerminal("completed"))
        assertTrue(RelayProtocol.isTerminal("failed"))
        assertTrue(RelayProtocol.isTerminal("blocked"))
        assertTrue(RelayProtocol.isTerminal("cancelled"))
        assertFalse(RelayProtocol.isTerminal("implementing"))
        assertFalse(RelayProtocol.isTerminal("queued"))
    }
}
