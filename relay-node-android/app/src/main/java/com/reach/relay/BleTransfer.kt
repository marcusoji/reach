package com.reach.relay

/** Reassembles BLE fragments: [seq:1][total:1][payload...] */
class BleTransfer {
    private val parts = HashMap<Int, ByteArray>()
    private var total = -1
    private var lastActive = System.currentTimeMillis()

    fun accept(value: ByteArray): ByteArray? {
        if (value.size < 3) return null
        val seq = value[0].toInt() and 0xff
        val t = value[1].toInt() and 0xff
        if (t <= 0 || t > 512) return null
        if (total < 0) total = t
        if (t != total) { reset(); total = t }
        parts[seq] = value.copyOfRange(2, value.size)
        lastActive = System.currentTimeMillis()
        if (parts.size < total) return null
        val out = ArrayList<Byte>()
        for (i in 0 until total) {
            val p = parts[i] ?: run { reset(); return null }
            out.addAll(p.toList())
        }
        reset()
        return out.toByteArray()
    }

    fun reset() {
        parts.clear(); total = -1
    }
}
