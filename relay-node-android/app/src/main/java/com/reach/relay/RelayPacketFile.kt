package com.reach.relay

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The native half of the offline "alert file" hand-off.
 *
 * A citizen with no relay node and no internet saves their signed packets as a `reach-relay-packets`
 * JSON document and transfers it (Bluetooth/Wi-Fi file share, USB, a nearby laptop). This object
 * turns that document into queue rows, and turns this node's own live queue back into the same
 * document — so a relay node can also be handed an alert file, and can hand one on.
 *
 * The packets are already source-signed, so an import only sanity-checks structure and expiry; the
 * gateway remains the authority on signatures and device registration, exactly as for a packet that
 * arrived over the radio. A packet that fails validation is rejected and never queued.
 */
object RelayPacketFile {
    const val FORMAT = "reach-relay-packets"
    const val VERSION = 1

    data class ImportResult(val accepted: Int, val skipped: Int, val rejected: Int)

    /**
     * Queue the packets in [text]. Accepts either the full document or a bare array of packets.
     * A packet that is already queued (same `k`), expired, or structurally invalid is skipped or
     * rejected rather than overwriting a live row.
     */
    fun importJson(context: Context, text: String): ImportResult {
        val packets = extractPackets(text) ?: throw IllegalArgumentException("Not a REACH relay packet file")
        val db = RelayQueueDb(context.applicationContext)
        val existing = db.livePackets().mapNotNull { runCatching { JSONObject(it).optString("k") }.getOrNull() }.toHashSet()
        var accepted = 0
        var skipped = 0
        var rejected = 0
        for (i in 0 until packets.length()) {
            val packet = packets.optJSONObject(i)
            if (packet == null) { rejected++; continue }
            // The gateway is the signature authority, but a malformed/expired packet must not enter
            // the queue at all: it would burn a hop and then dead-letter.
            val validated = try {
                RelayProtocol.validate(packet.toString().toByteArray(Charsets.UTF_8))
            } catch (_: Exception) {
                rejected++
                continue
            }
            val key = validated.optString("k")
            if (key.isBlank() || existing.contains(key)) {
                skipped++
                continue
            }
            db.enqueue(validated)
            existing.add(key)
            accepted++
        }
        if (accepted > 0) RelayForwarder.kick(context.applicationContext)
        return ImportResult(accepted, skipped, rejected)
    }

    /** This node's live queue as a transferable document (same shape the PWA writes). */
    fun exportJson(context: Context): String {
        val packets = JSONArray()
        for (raw in RelayQueueDb(context.applicationContext).livePackets()) {
            runCatching { packets.put(JSONObject(raw)) }
        }
        return JSONObject()
            .put("format", FORMAT)
            .put("version", VERSION)
            .put("exported_at", isoTimestamp())
            .put("packets", packets)
            .toString()
    }

    /** A file name that sorts chronologically and is safe on every file system. */
    fun fileName(): String = "reach-alert-${dateStamp()}.json"

    private fun extractPackets(text: String): JSONArray? {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return null
        return try {
            if (trimmed.startsWith("[")) {
                JSONArray(trimmed)
            } else {
                val doc = JSONObject(trimmed)
                val packets = doc.optJSONArray("packets") ?: return null
                packets
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun isoTimestamp(): String =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }.format(Date())

    private fun dateStamp(): String = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())
}
