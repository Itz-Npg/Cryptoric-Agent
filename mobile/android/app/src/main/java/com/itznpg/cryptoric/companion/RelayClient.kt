package com.itznpg.cryptoric.companion

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import kotlin.Unit

/**
 * The phone's half of the relay connection.
 *
 * OkHttp rather than `java.net.http.WebSocket`, because that package is not on
 * every API level this app supports and a companion that only connects on new
 * phones is a companion that looks broken on old ones.
 */
class RelayClient(
    private val url: String,
    private val onSnapshot: (RelayProtocol.Snapshot) -> Unit,
    private val onError: (String) -> Unit
) {
    private val http = OkHttpClient()
    private var socket: WebSocket? = null

    suspend fun connect() {
        val request = Request.Builder().url(url).build()
        withContext(Dispatchers.IO) {
            socket = http.newWebSocket(request, Listener())
        }
    }

    fun close() {
        socket?.close(1000, "done")
        socket = null
        http.dispatcher.executorService.shutdown()
    }

    private inner class Listener : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) {
            onSnapshot(RelayProtocol.decodeSnapshot(text))
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            // The reason is surfaced rather than swallowed: a phone that shows
            // "not connected" forever is indistinguishable from a phone whose
            // relay has nothing to say.
            onError(t.message ?: "The relay connection failed.")
        }
    }
}
