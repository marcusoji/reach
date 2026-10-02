package com.reach.relay

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Fragment reassembly must combine fragments only within one transfer. Two transfers that
 * happen to fragment into the same number of pieces and interleave on the same link must not
 * be mixed — the transfer id is what separates them.
 */
class BleTransferTest {
    private fun frame(id: ByteArray, seq: Int, total: Int, body: String) =
        BleTransfer.frame(id, seq, total, body.toByteArray(Charsets.UTF_8))

    @Test
    fun `reassembles a single transfer in order`() {
        val t = BleTransfer()
        val id = byteArrayOf(1, 2, 3, 4)
        assertNull(t.accept(frame(id, 0, 3, "AAA")))
        assertNull(t.accept(frame(id, 1, 3, "BBB")))
        val done = t.accept(frame(id, 2, 3, "CCC"))
        assertEquals("AAABBBCCC", String(done!!, Charsets.UTF_8))
    }

    @Test
    fun `reassembles out of order`() {
        val t = BleTransfer()
        val id = byteArrayOf(9, 9, 9, 9)
        assertNull(t.accept(frame(id, 2, 3, "C")))
        assertNull(t.accept(frame(id, 0, 3, "A")))
        val done = t.accept(frame(id, 1, 3, "B"))
        assertEquals("ABC", String(done!!, Charsets.UTF_8))
    }

    @Test
    fun `interleaved transfers with the same fragment count are not mixed`() {
        val t = BleTransfer()
        val a = byteArrayOf(0, 0, 0, 1)
        val b = byteArrayOf(0, 0, 0, 2)
        // A1, B1, A2, B2, A3, B3 — same total (3) for both.
        assertNull(t.accept(frame(a, 0, 3, "A1")))
        assertNull(t.accept(frame(b, 0, 3, "B1")))
        assertNull(t.accept(frame(a, 1, 3, "A2")))
        assertNull(t.accept(frame(b, 1, 3, "B2")))
        val aDone = t.accept(frame(a, 2, 3, "A3"))
        assertEquals("A1A2A3", String(aDone!!, Charsets.UTF_8))
        val bDone = t.accept(frame(b, 2, 3, "B3"))
        assertEquals("B1B2B3", String(bDone!!, Charsets.UTF_8))
    }

    @Test
    fun `a different total for the same transfer id restarts the transfer`() {
        val t = BleTransfer()
        val id = byteArrayOf(7, 7, 7, 7)
        assertNull(t.accept(frame(id, 0, 3, "A")))
        assertNull(t.accept(frame(id, 1, 3, "B")))
        // A new transfer reusing the id with a different total must not splice the old fragments.
        assertNull(t.accept(frame(id, 0, 2, "X")))
        val done = t.accept(frame(id, 1, 2, "Y"))
        assertEquals("XY", String(done!!, Charsets.UTF_8))
    }

    @Test
    fun `rejects malformed frames`() {
        val t = BleTransfer()
        assertNull(t.accept(ByteArray(5)))                      // shorter than the header
        assertNull(t.accept(frame(byteArrayOf(1, 1, 1, 1), 0, 0, "")))  // total 0
        assertNull(t.accept(frame(byteArrayOf(1, 1, 1, 1), 3, 2, "x"))) // seq >= total
    }

    @Test
    fun `frame layout matches the documented header`() {
        val id = byteArrayOf(0x0a, 0x0b, 0x0c, 0x0d)
        val f = BleTransfer.frame(id, 2, 5, "PAY".toByteArray())
        assertEquals(6 + 3, f.size)
        assertArrayEquals(id, f.copyOfRange(0, 4))
        assertEquals(2, f[4].toInt())
        assertEquals(5, f[5].toInt())
        assertArrayEquals("PAY".toByteArray(), f.copyOfRange(6, f.size))
    }

    @Test
    fun `completed transfers are evicted and do not leak`() {
        val t = BleTransfer()
        val id = byteArrayOf(3, 3, 3, 3)
        assertNotNull(t.accept(frame(id, 0, 1, "Z")))
        // A second, unrelated single-fragment transfer with a new id still works.
        val done = t.accept(frame(byteArrayOf(4, 4, 4, 4), 0, 1, "W"))
        assertEquals("W", String(done!!, Charsets.UTF_8))
    }

    @Test
    fun `reset clears partial transfers`() {
        val t = BleTransfer()
        val id = byteArrayOf(5, 5, 5, 5)
        assertNull(t.accept(frame(id, 0, 2, "A")))
        t.reset()
        // After reset, fragment 1 alone cannot complete a 2-fragment transfer.
        assertNull(t.accept(frame(id, 1, 2, "B")))
    }

    @Test
    fun `max total is bounded by a single header byte`() {
        assertTrue(BleTransfer.MAX_TOTAL in 1..255)
    }
}
