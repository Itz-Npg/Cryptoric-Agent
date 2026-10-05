package com.itznpg.cryptoric.companion

import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * The Android companion.
 *
 * As on iOS, almost all of it is a relay address and a list of tasks. The rules
 * — which statuses degrade, what "needs attention" means, how a task is
 * normalised — live in [RelayProtocol] and are unit tested there, because a
 * screen is the one thing a JVM test cannot reach and a screen is not where
 * wire bugs should be found.
 */
class MainActivity : AppCompatActivity() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var client: RelayClient? = null

    private lateinit var address: EditText
    private lateinit var status: TextView
    private lateinit var connect: Button
    private lateinit var tasks: LinearLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildUi()
    }

    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 48, 48, 48)
        }

        root.addView(TextView(this).apply { text = "Cryptoric" ; textSize = 28f })

        address = EditText(this).apply {
            setText("ws://10.0.2.2:8787")
            hint = "ws://…"
            setSingleLine()
        }
        root.addView(address)

        status = TextView(this).apply { text = "Not connected." }
        root.addView(status)

        connect = Button(this).apply { text = "Connect" ; setOnClickListener { onConnect() } }
        root.addView(connect)

        tasks = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(tasks)

        setContentView(android.widget.ScrollView(this).apply { addView(root) })
    }

    private fun onConnect() {
        val url = address.text.toString().trim()
        if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
            status.text = "The relay speaks WebSocket. Use ws:// or wss://."
            return
        }

        connect.isEnabled = false
        status.text = "Connecting…"
        tasks.removeAllViews()

        val started = RelayClient(url, onSnapshot = ::render, onError = { message ->
            scope.launch {
                status.text = message
                connect.isEnabled = true
            }
        })
        client = started
        scope.launch { started.connect() }
    }

    private fun render(snapshot: RelayProtocol.Snapshot) {
        tasks.removeAllViews()
        snapshot.error?.let { status.text = it; return }

        status.text = if (snapshot.tasks.isEmpty()) "Connected. Nothing running." else "Connected."
        for (task in snapshot.tasks) {
            tasks.addView(TextView(this).apply {
                text = "${task.title.ifEmpty { task.id }} — ${task.status}"
                textSize = if (task.needsAttention) 18f else 15f
                setPadding(0, 12, 0, 0)
            })
            if (task.lastNote.isNotEmpty()) {
                tasks.addView(TextView(this).apply {
                    text = task.lastNote
                    textSize = 12f
                })
            }
        }
    }

    override fun onDestroy() {
        client?.close()
        scope.cancel()
        super.onDestroy()
    }
}
