package com.reach.relay

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject

/**
 * Forwards due packets over BLE then Wi-Fi Direct.
 * Deletes only after verified ACK. Crash during SENDING recovers to PENDING.
 */
object RelayForwarder {
    private const val TAG = "ReachRelay"
    @Volatile private var running = false
    private val handler = Handler(Looper.getMainLooper())

    fun enqueue(context: Context, packet: JSONObject) {
        try {
            val validated = RelayProtocol.validate(packet.toString().toByteArray(Charsets.UTF_8))
            RelayQueueDb(context.applicationContext).enqueue(validated)
            kick(context.applicationContext)
        } catch (e: Exception) {
            Log.w(TAG, "enqueue rejected: ${e.message}")
        }
    }

    fun kick(context: Context) {
        if (running) return
        running = true
        handler.post { drain(context.applicationContext) }
    }

    private fun drain(context: Context) {
        val db = RelayQueueDb(context)
        db.purgeExpired()
        db.recoverStaleSending()
        val batch = db.due(5)
        if (batch.isEmpty()) {
            running = false
            // periodic cleanup even when idle
            handler.postDelayed({ running = false; kick(context) }, 60_000L)
            return
        }
        processNext(context, db, batch, 0)
    }

    private fun processNext(context: Context, db: RelayQueueDb, batch: List<Pair<String, JSONObject>>, index: Int) {
        if (index >= batch.size) {
            running = false
            handler.postDelayed({ kick(context) }, 2_000L)
            return
        }
        val (id, packet) = batch[index]
        val now = System.currentTimeMillis()
        if (now >= packet.optLong("e", 0L)) {
            db.success(id) // purge expired
            processNext(context, db, batch, index + 1)
            return
        }
        val hops = packet.optInt("h", 0)
        val max = packet.optInt("m", RelayProtocol.MAX_HOPS).coerceAtMost(RelayProtocol.MAX_HOPS)
        if (hops >= max) {
            db.markDead(id, "hop_limit")
            processNext(context, db, batch, index + 1)
            return
        }

        val toSend = try {
            RelayProtocol.nextHop(packet)
        } catch (e: Exception) {
            db.markDead(id, e.message ?: "next_hop")
            processNext(context, db, batch, index + 1)
            return
        }
        val bytes = toSend.toString().toByteArray(Charsets.UTF_8)
        val hash = toSend.optString("x")
        val attempts = packet.optInt("_attempts_local", 0)

        db.markSending(id, "ble", null)
        BleCentralRelay(context).discoverAndSendWithAck(bytes, id, hash) { bleOk, peer ->
            if (bleOk) {
                db.success(id)
                processNext(context, db, batch, index + 1)
            } else {
                db.markSending(id, "wifi", null)
                WifiDirectRelay(context).sendWithAck(bytes, id, hash) { wifiOk, wifiPeer ->
                    if (wifiOk) {
                        db.success(id)
                    } else {
                        val nextAttempts = attempts + 1
                        db.retry(id, nextAttempts, "no_ack", "ble+wifi")
                    }
                    processNext(context, db, batch, index + 1)
                }
            }
        }
    }
}
