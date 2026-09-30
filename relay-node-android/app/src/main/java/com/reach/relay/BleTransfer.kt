package com.reach.relay

import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Reassembles MTU-sized BLE fragments with bounds and timeout protection. */
class BleTransfer {
    private data class Buffer(val total:Int, val parts:MutableMap<Int,ByteArray>, val created:Long)
    private val buffers = ConcurrentHashMap<String, Buffer>()
    private val cleaner = Executors.newSingleThreadScheduledExecutor()

    init { cleaner.scheduleAtFixedRate({ cleanup() }, 10, 10, TimeUnit.SECONDS) }

    fun accept(frame: ByteArray): ByteArray? {
        require(frame.size >= 20) { "Malformed relay frame" }
        val transferId = frame.copyOfRange(0, 16).toHex()
        val seq = ((frame[16].toInt() and 0xff) shl 8) or (frame[17].toInt() and 0xff)
        val total = ((frame[18].toInt() and 0xff) shl 8) or (frame[19].toInt() and 0xff)
        require(total in 1..64 && seq in 0 until total) { "Invalid BLE fragment" }
        val data = frame.copyOfRange(20, frame.size)
        val b = buffers.computeIfAbsent(transferId) { Buffer(total, mutableMapOf(), System.currentTimeMillis()) }
        synchronized(b) {
            if (b.total != total) { buffers.remove(transferId); throw IllegalArgumentException("Fragment mismatch") }
            b.parts.putIfAbsent(seq, data)
            if (b.parts.size != total) return null
            val out = ByteArrayOutputStream()
            for (i in 0 until total) out.write(b.parts[i])
            buffers.remove(transferId)
            return out.toByteArray()
        }
    }

    private fun cleanup() {
        val cutoff = System.currentTimeMillis() - 30_000
        buffers.entries.removeIf { it.value.created < cutoff }
    }

    private fun ByteArray.toHex() = joinToString("") { "%02x".format(it) }
}
