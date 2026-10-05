package com.itznpg.cryptoric.companion

import org.json.JSONArray
import org.json.JSONObject

/**
 * The relay's wire format, on the Android side.
 *
 * A port of `mobile/relay/src/protocol.js`. The field names are a contract with
 * that file and with `mobile/ios/Sources/CryptoricKit/RelayProtocol.swift`;
 * renaming a field on one side only is the classic way a companion silently
 * shows nothing, so the decoding here is unit tested in
 * `RelayProtocolTest` against the same cases the JavaScript suite uses.
 *
 * Tolerant on the way in, strict on the way out: an unknown status degrades to
 * `blocked` and never to `completed`, because a newer desktop reporting a
 * status this build has not heard of must not be shown as a success.
 */
object RelayProtocol {

    const val UNKNOWN_STATUS = "blocked"

    val STATUSES = listOf(
        "queued", "planning", "implementing", "verifying",
        "completed", "failed", "blocked", "cancelled"
    )

    private val TERMINAL = setOf("completed", "failed", "blocked", "cancelled")

    fun isTerminal(status: String): Boolean = status in TERMINAL

    fun isSuccess(status: String): Boolean = status == "completed"

    /** One task, exactly as the UI needs it. */
    data class Task(
        val id: String,
        val title: String,
        val status: String,
        val stage: String,
        val lastNote: String,
        val updatedAt: String,
        val changedPaths: List<String>
    ) {
        /** The rows that belong at the top of the list. */
        val needsAttention: Boolean
            get() = status == "failed" || status == "blocked"
    }

    /** Everything the screen draws. */
    data class Snapshot(val tasks: List<Task>, val error: String? = null) {
        val active: List<Task> get() = tasks.filter { !isTerminal(it.status) }
        val finished: List<Task> get() = tasks.filter { isTerminal(it.status) }
    }

    /**
     * Decode a snapshot from one wire message.
     *
     * A malformed message returns a snapshot carrying the error rather than
     * throwing: a phone that crashes because the desktop sent something new is
     * worse than one that says it could not read the last update.
     */
    fun decodeSnapshot(text: String): Snapshot {
        return try {
            val root = JSONObject(text)
            val array: JSONArray = root.optJSONArray("tasks") ?: JSONArray()
            val tasks = (0 until array.length()).map { index ->
                normaliseTask(array.optJSONObject(index))
            }
            Snapshot(tasks = tasks)
        } catch (err: Exception) {
            Snapshot(tasks = emptyList(), error = "Could not read that update: ${err.message}")
        }
    }

    /** Normalise one task off the wire. */
    fun normaliseTask(raw: JSONObject?): Task {
        val status = raw?.optString("status").orEmpty()
        val paths = raw?.optJSONArray("changedPaths")
        return Task(
            id = raw?.optString("id").orEmpty(),
            title = raw?.optString("title").orEmpty(),
            status = if (STATUSES.contains(status)) status else UNKNOWN_STATUS,
            stage = raw?.optString("stage").orEmpty(),
            lastNote = raw?.optString("lastNote").orEmpty(),
            updatedAt = raw?.optString("updatedAt").orEmpty(),
            changedPaths = paths?.let { array ->
                (0 until array.length()).map { array.optString(it) }
            } ?: emptyList()
        )
    }
}
