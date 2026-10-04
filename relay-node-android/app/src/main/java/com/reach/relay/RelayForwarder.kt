package com.reach.relay

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject

/**
 * Drains due packets: a node with gateway connectivity uploads directly, otherwise it forwards
 * over BLE then Wi-Fi Direct. Deletes only after a verified ACK (radio) or a 2xx upload.
 * Crash during SENDING recovers to PENDING.
 */
object RelayForwarder {
    private const val TAG = "ReachRelay"
    @Volatile private var running = false
    private val handler = Handler(Looper.getMainLooper())
    // Gateway uploads block on HTTP, which is not allowed on the main thread; radio forwarding is
    // asynchronous and returns on the main looper, so only the upload path needs its own thread.
    private val io = java.util.concurrent.Executors.newSingleThreadExecutor()

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

        // Connected node: upload straight to the gateway. A node with a configured gateway but no
        // internet must NOT stay on this branch: the upload would fail every cycle and the packet
        // would never be tried over the radio. That is exactly the "no network, send, and nothing
        // goes" case — so only upload when there is connectivity, otherwise fall through to the hop.
        if (RelayRouting.gatewayRouteAvailable(
                RelayGatewayUploader.isConfigured(context),
                RelayGatewayUploader.hasConnectivity(context),
            )
        ) {
            db.markSending(id, "gateway", null)
            io.execute {
                val delivered = RelayGatewayUploader.upload(context, packet)
                handler.post {
                    if (delivered) {
                        db.success(id)
                        processNext(context, db, batch, index + 1)
                    } else {
                        // The uplink dropped between the check and the upload: hand the packet to the
                        // radio hop before rescheduling, so it still has two ways to get out.
                        sendViaRadio(context, db, batch, index, id, packet)
                    }
                }
            }
            return
        }

        sendViaRadio(context, db, batch, index, id, packet)
    }

    /** Offer the packet to a nearby peer over BLE, then Wi-Fi Direct, before giving up. */
    private fun sendViaRadio(
        context: Context,
        db: RelayQueueDb,
        batch: List<Pair<String, JSONObject>>,
        index: Int,
        id: String,
        packet: JSONObject
    ) {
        val toSend = try {
            RelayProtocol.nextHop(packet)
        } catch (e: Exception) {
            db.markDead(id, e.message ?: "next_hop")
            processNext(context, db, batch, index + 1)
            return
        }
        val bytes = toSend.toString().toByteArray(Charsets.UTF_8)
        val hash = toSend.optString("x")

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
                        db.retry(id, "no_ack", "ble+wifi")
                    }
                    processNext(context, db, batch, index + 1)
                }
            }
        }
    }
}
