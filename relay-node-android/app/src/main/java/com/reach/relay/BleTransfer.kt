package com.reach.relay

/**
 * Reassembles BLE fragments into a packet.
 *
 * Frame layout: [transferId:4][seq:1][total:1][payload...]. The transfer id lets two transfers
 * that happen to fragment into the same number of pieces share a link without their fragments
 * being mixed: fragments are only ever combined within one transfer. A transfer that stops
 * progressing is evicted so a partial never lingers.
 */
class BleTransfer {
    private class Partial(var total: Int) {
        val parts = HashMap<Int, ByteArray>()
        var lastActive = System.currentTimeMillis()
    }

    private val transfers = HashMap<String, Partial>()

    fun accept(value: ByteArray): ByteArray? {
        if (value.size < HEADER) return null
        val id = idOf(value)
        val seq = value[4].toInt() and 0xff
        val total = value[5].toInt() and 0xff
        if (total <= 0 || seq >= total) return null
        evictStale()
        val partial = transfers.getOrPut(id) { Partial(total) }
        if (partial.total != total) {
            // Same id, new framing: a different transfer reusing the id, so drop the old pieces.
            partial.parts.clear()
            partial.total = total
        }
        partial.parts[seq] = value.copyOfRange(HEADER, value.size)
        partial.lastActive = System.currentTimeMillis()
        if (partial.parts.size < total) return null
        val out = ArrayList<Byte>(value.size * total)
        for (i in 0 until total) {
            val part = partial.parts[i] ?: run { transfers.remove(id); return null }
            for (b in part) out.add(b)
        }
        transfers.remove(id)
        return out.toByteArray()
    }

    fun reset() = transfers.clear()

    private fun evictStale() {
        val cutoff = System.currentTimeMillis() - STALE_MS
        transfers.entries.removeAll { it.value.lastActive < cutoff }
    }

    private fun idOf(v: ByteArray): String {
        val sb = StringBuilder(8)
        for (i in 0 until 4) sb.append("%02x".format(v[i].toInt() and 0xff))
        return sb.toString()
    }

    companion object {
        /** transferId(4) + seq(1) + total(1). */
        const val HEADER = 6
        const val MAX_TOTAL = 255
        const val STALE_MS = 30_000L

        /** Build a frame for one fragment. Shared with the central so both sides agree. */
        fun frame(transferId: ByteArray, seq: Int, total: Int, body: ByteArray): ByteArray {
            val frame = ByteArray(HEADER + body.size)
            System.arraycopy(transferId, 0, frame, 0, 4)
            frame[4] = seq.toByte()
            frame[5] = total.toByte()
            System.arraycopy(body, 0, frame, HEADER, body.size)
            return frame
        }
    }
}

