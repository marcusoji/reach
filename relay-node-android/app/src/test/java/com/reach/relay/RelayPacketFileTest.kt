package com.reach.relay

import androidx.test.core.app.ApplicationProvider
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The alert-file hand-off is the offline citizen's last resort: a signed packet saved as JSON and
 * carried by hand to a relay node. These tests pin that a real signed packet round-trips through
 * the document, that a duplicate/expired/malformed packet never enters the queue, and that a
 * non-REACH file is refused rather than half-imported.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class RelayPacketFileTest {

    private val context get() = ApplicationProvider.getApplicationContext<android.content.Context>()

    private fun signedPacket(): JSONObject = RelayProtocol.newPacket(
        JSONObject()
            .put("k", "pkt-" + java.util.UUID.randomUUID().toString())
            .put("incident_id", JSONObject.NULL)
            .put("minimal_payload", JSONObject().put("category", "fire").put("priority", "high").put("title", "Fire"))
    )

    private fun document(vararg packets: JSONObject): String {
        val arr = JSONArray()
        packets.forEach { arr.put(it) }
        return JSONObject().put("format", RelayPacketFile.FORMAT).put("version", 1).put("packets", arr).toString()
    }

    @Test
    fun `a signed packet round-trips through export and import`() {
        RelayQueueDb(context).writableDatabase.delete("relay_queue", null, null)
        RelayQueueDb(context).enqueue(signedPacket())

        val exported = JSONObject(RelayPacketFile.exportJson(context))
        assertEquals(RelayPacketFile.FORMAT, exported.getString("format"))
        assertEquals(1, exported.getJSONArray("packets").length())

        RelayQueueDb(context).writableDatabase.delete("relay_queue", null, null)
        val result = RelayPacketFile.importJson(context, exported.toString())
        assertEquals(1, result.accepted)
        assertEquals(0, result.rejected)
        assertEquals(1, RelayQueueDb(context).livePackets().size)
    }

    @Test
    fun `re-importing the same file is a no-op`() {
        RelayQueueDb(context).writableDatabase.delete("relay_queue", null, null)
        val packet = signedPacket()
        val doc = document(packet)
        assertEquals(1, RelayPacketFile.importJson(context, doc).accepted)
        val again = RelayPacketFile.importJson(context, doc)
        assertEquals(0, again.accepted)
        assertEquals(1, again.skipped)
        assertEquals(1, RelayQueueDb(context).livePackets().size)
    }

    @Test
    fun `malformed and expired packets are rejected, not queued`() {
        RelayQueueDb(context).writableDatabase.delete("relay_queue", null, null)
        val expired = signedPacket().put("e", System.currentTimeMillis() - 1000)
        val doc = JSONObject()
            .put("packets", JSONArray().put(JSONObject().put("k", "x")).put(JSONObject.NULL).put(expired))
            .toString()
        val result = RelayPacketFile.importJson(context, doc)
        assertEquals(0, result.accepted)
        assertEquals(3, result.rejected)
        assertEquals(0, RelayQueueDb(context).livePackets().size)
    }

    @Test
    fun `a bare array of packets is accepted`() {
        RelayQueueDb(context).writableDatabase.delete("relay_queue", null, null)
        val arr = JSONArray().put(signedPacket())
        assertEquals(1, RelayPacketFile.importJson(context, arr.toString()).accepted)
    }

    @Test
    fun `a non-packet document is refused`() {
        var threw = false
        try {
            RelayPacketFile.importJson(context, "{\"not\":\"a file\"}")
        } catch (_: IllegalArgumentException) {
            threw = true
        }
        assertTrue(threw)
    }

    @Test
    fun `export excludes dead-lettered packets`() {
        RelayQueueDb(context).writableDatabase.delete("relay_queue", null, null)
        val packet = signedPacket()
        RelayQueueDb(context).enqueue(packet)
        RelayQueueDb(context).markDead(packet.getString("k"), "no_ack")
        val exported = JSONObject(RelayPacketFile.exportJson(context))
        assertEquals(0, exported.getJSONArray("packets").length())
    }

    @Test
    fun `exported file name is a dated json name`() {
        val name = RelayPacketFile.fileName()
        assertTrue(name.startsWith("reach-alert-"))
        assertTrue(name.endsWith(".json"))
        assertNotNull(name)
    }
}
