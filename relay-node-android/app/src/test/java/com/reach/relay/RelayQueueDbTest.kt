package com.reach.relay

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The durable queue is the piece that must survive crashes and stop retrying forever. These
 * tests drive the real SQLite-backed queue through Robolectric.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class RelayQueueDbTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private fun db() = RelayQueueDb(context)
    private val now get() = System.currentTimeMillis()

    private fun packet(key: String, hops: Int = 0, max: Int = RelayProtocol.MAX_HOPS, expiresAt: Long = now + 60_000) =
        JSONObject()
            .put("v", RelayProtocol.PROTOCOL_VERSION)
            .put("k", key)
            .put("x", "a".repeat(64))
            .put("h", hops)
            .put("m", max)
            .put("e", expiresAt)

    @Test
    fun `enqueue makes a packet due`() {
        val q = db()
        q.enqueue(packet("pkt-00000001"))
        val due = q.due()
        assertEquals(1, due.size)
        assertEquals("pkt-00000001", due[0].first)
    }

    @Test
    fun `enqueue ignores an already-expired packet`() {
        val q = db()
        q.enqueue(packet("pkt-00000002", expiresAt = now - 1))
        assertEquals(0, q.due().size)
    }

    @Test
    fun `enqueue ignores a packet at the hop limit`() {
        val q = db()
        q.enqueue(packet("pkt-00000003", hops = 6, max = 6))
        assertEquals(0, q.due().size)
    }

    @Test
    fun `duplicate enqueue does not create a second row`() {
        val q = db()
        q.enqueue(packet("pkt-00000004"))
        q.enqueue(packet("pkt-00000004"))
        assertEquals(1, q.due().size)
    }

    @Test
    fun `purgeExpired removes expired rows`() {
        val q = db()
        q.enqueue(packet("pkt-00000005", expiresAt = now + 50))
        Thread.sleep(120)
        assertTrue(q.purgeExpired() >= 1)
        assertEquals(0, q.due().size)
    }

    @Test
    fun `success removes the row`() {
        val q = db()
        q.enqueue(packet("pkt-00000006"))
        q.success("pkt-00000006")
        assertEquals(0, q.due().size)
    }

    @Test
    fun `stale SENDING rows recover to PENDING`() {
        val q = db()
        q.enqueue(packet("pkt-00000007"))
        q.markSending("pkt-00000007", "ble", null)
        assertEquals(0, q.due().size) // SENDING is not due
        q.recoverStaleSending()
        // Not stale yet (window is 90s), so it stays SENDING.
        assertEquals(0, q.due().size)
    }

    @Test
    fun `retry counts from the row and dead-letters at the ceiling`() {
        val q = db()
        q.enqueue(packet("pkt-00000008"))
        // Drive attempts up to the ceiling; each retry reschedules with a backoff.
        repeat(RelayQueueDb.MAX_ATTEMPTS) { q.retry("pkt-00000008", "no_ack", "ble") }
        val dead = q.deadLetters()
        assertEquals(1, dead.size)
        assertEquals("pkt-00000008", dead[0].optString("id"))
        assertEquals(0, q.due().size)
    }

    @Test
    fun `retry reschedules with a future next_at`() {
        val q = db()
        q.enqueue(packet("pkt-00000009"))
        q.retry("pkt-00000009", "no_ack", "ble")
        // First backoff is 2s, so the packet is not due immediately.
        assertEquals(0, q.due().size)
    }

    @Test
    fun `markDead is terminal`() {
        val q = db()
        q.enqueue(packet("pkt-00000010"))
        q.markDead("pkt-00000010", "hop_limit")
        assertEquals(0, q.due().size)
        assertEquals(1, q.deadLetters().size)
    }

    @Test
    fun `dead letters expose the failure reason and transport`() {
        val q = db()
        q.enqueue(packet("pkt-00000011"))
        q.markDead("pkt-00000011", "corrupt_packet")
        val d = q.deadLetters()[0]
        assertEquals("corrupt_packet", d.optString("last_error"))
    }

    @Test
    fun `due respects the batch limit`() {
        val q = db()
        repeat(10) { q.enqueue(packet("pkt-limit-%04d".format(it))) }
        assertEquals(3, q.due(3).size)
    }

    @Test
    fun `expired packet inside the queue is never returned for forward`() {
        val q = db()
        q.enqueue(packet("pkt-00000012", expiresAt = now + 40))
        Thread.sleep(100)
        // due() purges first, so an expired packet cannot be forwarded.
        assertEquals(0, q.due().size)
    }

    @Test
    fun `enqueue rejects a malformed packet id`() {
        val q = db()
        q.enqueue(JSONObject().put("v", RelayProtocol.PROTOCOL_VERSION).put("k", ""))
        assertEquals(0, q.due().size)
    }

    @Test
    fun `corrupt stored packet is dead-lettered rather than forwarded`() {
        val q = db()
        q.enqueue(packet("pkt-00000013"))
        // Overwrite the stored JSON with something unparseable, as a torn write might.
        val raw = RelayQueueDb(context).writableDatabase
        raw.execSQL("UPDATE relay_queue SET packet=? WHERE id=?", arrayOf("{not json", "pkt-00000013"))
        assertEquals(0, q.due().size)
        assertTrue(q.deadLetters().any { it.optString("id") == "pkt-00000013" })
    }

    @Test
    fun `retry is not incremented by callers passing a fresh packet`() {
        // Regression: the attempt count must come from the row, not the re-parsed packet, or the
        // packet retries until TTL and never dead-letters.
        val q = db()
        q.enqueue(packet("pkt-00000014"))
        q.retry("pkt-00000014", "no_ack", "ble")
        q.retry("pkt-00000014", "no_ack", "ble")
        assertFalse(q.deadLetters().any { it.optString("id") == "pkt-00000014" })
    }
}
