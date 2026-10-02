package com.reach.relay

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONObject

/**
 * Durable relay queue.
 * States: PENDING → SENDING → (ACKED delete) | PENDING (crash/timeout) | DEAD_LETTER
 * Expired packets are never forwarded and are purged.
 */
class RelayQueueDb(context: Context) : SQLiteOpenHelper(context, "reach-relay.db", null, 2) {
    companion object {
        const val STATE_PENDING = "PENDING"
        const val STATE_SENDING = "SENDING"
        const val STATE_DEAD = "DEAD_LETTER"
        const val MAX_ATTEMPTS = 8
        const val SENDING_STALE_MS = 90_000L
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE relay_queue(
                id TEXT PRIMARY KEY,
                packet TEXT NOT NULL,
                packet_hash TEXT NOT NULL DEFAULT '',
                state TEXT NOT NULL DEFAULT 'PENDING',
                attempts INTEGER NOT NULL DEFAULT 0,
                next_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                last_error TEXT,
                last_transport TEXT,
                last_peer TEXT,
                hop INTEGER NOT NULL DEFAULT 0
            )"""
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_relay_queue_due ON relay_queue(state, next_at, expires_at)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) {
            db.execSQL("ALTER TABLE relay_queue ADD COLUMN packet_hash TEXT NOT NULL DEFAULT ''")
            db.execSQL("ALTER TABLE relay_queue ADD COLUMN state TEXT NOT NULL DEFAULT 'PENDING'")
            db.execSQL("ALTER TABLE relay_queue ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0")
            db.execSQL("ALTER TABLE relay_queue ADD COLUMN last_error TEXT")
            db.execSQL("ALTER TABLE relay_queue ADD COLUMN last_transport TEXT")
            db.execSQL("ALTER TABLE relay_queue ADD COLUMN last_peer TEXT")
            db.execSQL("ALTER TABLE relay_queue ADD COLUMN hop INTEGER NOT NULL DEFAULT 0")
            // Backfill expiry from packet JSON when possible is handled at runtime.
            db.execSQL("UPDATE relay_queue SET expires_at = created_at + ${RelayProtocol.TTL_MS} WHERE expires_at = 0")
        }
    }

    @Synchronized
    fun enqueue(packet: JSONObject) {
        val id = packet.optString("k")
        if (id.isBlank()) return
        val now = System.currentTimeMillis()
        val expires = packet.optLong("e", now + RelayProtocol.TTL_MS)
        if (now >= expires) return // never enqueue expired
        val hops = packet.optInt("h", 0)
        val max = packet.optInt("m", RelayProtocol.MAX_HOPS)
        if (hops >= max || max > RelayProtocol.MAX_HOPS) return
        writableDatabase.execSQL(
            """INSERT OR IGNORE INTO relay_queue(
                id,packet,packet_hash,state,attempts,next_at,created_at,expires_at,hop
            ) VALUES(?,?,?,?,?,?,?,?,?)""",
            arrayOf(
                id,
                packet.toString(),
                packet.optString("x"),
                STATE_PENDING,
                0,
                now,
                now,
                expires,
                hops
            )
        )
    }

    /** Recover crash: SENDING rows older than stale window return to PENDING. */
    @Synchronized
    fun recoverStaleSending() {
        val cutoff = System.currentTimeMillis() - SENDING_STALE_MS
        writableDatabase.execSQL(
            "UPDATE relay_queue SET state=? WHERE state=? AND next_at<?",
            arrayOf(STATE_PENDING, STATE_SENDING, cutoff)
        )
    }

    /** Delete or dead-letter expired packets; never return them for forward. */
    @Synchronized
    fun purgeExpired(): Int {
        val now = System.currentTimeMillis()
        val n = writableDatabase.delete("relay_queue", "expires_at<=?", arrayOf(now.toString()))
        return n
    }

    @Synchronized
    fun due(limit: Int = 20): List<Pair<String, JSONObject>> {
        recoverStaleSending()
        purgeExpired()
        val now = System.currentTimeMillis()
        val out = mutableListOf<Pair<String, JSONObject>>()
        readableDatabase.rawQuery(
            """SELECT id,packet FROM relay_queue
               WHERE state=? AND next_at<=? AND expires_at>? AND attempts<?
               ORDER BY created_at LIMIT ?""",
            arrayOf(STATE_PENDING, now.toString(), now.toString(), MAX_ATTEMPTS.toString(), limit.toString())
        ).use { c ->
            while (c.moveToNext()) {
                try {
                    val packet = JSONObject(c.getString(1))
                    // Hard check before forward
                    if (now >= packet.optLong("e", 0L)) {
                        writableDatabase.delete("relay_queue", "id=?", arrayOf(c.getString(0)))
                        continue
                    }
                    if (packet.optInt("h", 0) >= packet.optInt("m", RelayProtocol.MAX_HOPS)) {
                        markDead(c.getString(0), "hop_limit")
                        continue
                    }
                    out += c.getString(0) to packet
                } catch (_: Exception) {
                    markDead(c.getString(0), "corrupt_packet")
                }
            }
        }
        return out
    }

    @Synchronized
    fun markSending(id: String, transport: String, peer: String?) {
        writableDatabase.execSQL(
            "UPDATE relay_queue SET state=?, last_transport=?, last_peer=?, next_at=? WHERE id=?",
            arrayOf(STATE_SENDING, transport, peer, System.currentTimeMillis(), id)
        )
    }

    /** Only delete after verified ACK. */
    @Synchronized
    fun success(id: String) {
        writableDatabase.delete("relay_queue", "id=?", arrayOf(id))
    }

    /** Increment the persisted attempt count and reschedule, or dead-letter at the ceiling.
     *  The count must come from the row, not the caller: the in-memory packet is re-parsed from
     *  JSON on every drain, so any counter carried there resets to zero each cycle and the packet
     *  would retry until TTL instead of ever dead-lettering. */
    @Synchronized
    fun retry(id: String, error: String?, transport: String?) {
        var current = 0
        readableDatabase.rawQuery("SELECT attempts FROM relay_queue WHERE id=?", arrayOf(id)).use { c ->
            if (c.moveToFirst()) current = c.getInt(0)
        }
        val next = current + 1
        if (next >= MAX_ATTEMPTS) {
            markDead(id, error ?: "max_attempts")
            return
        }
        val delay = (1000L shl next.coerceAtMost(6)).coerceAtMost(120_000L)
        writableDatabase.execSQL(
            "UPDATE relay_queue SET state=?, attempts=?, next_at=?, last_error=?, last_transport=? WHERE id=?",
            arrayOf(
                STATE_PENDING,
                next,
                System.currentTimeMillis() + delay,
                error?.take(500),
                transport,
                id
            )
        )
    }

    @Synchronized
    fun markDead(id: String, reason: String) {
        writableDatabase.execSQL(
            "UPDATE relay_queue SET state=?, last_error=?, next_at=? WHERE id=?",
            arrayOf(STATE_DEAD, reason.take(500), System.currentTimeMillis(), id)
        )
    }

    @Synchronized
    fun deadLetters(limit: Int = 50): List<JSONObject> {
        val out = mutableListOf<JSONObject>()
        readableDatabase.rawQuery(
            "SELECT id,packet,attempts,last_error,last_transport,last_peer,expires_at FROM relay_queue WHERE state=? ORDER BY next_at DESC LIMIT ?",
            arrayOf(STATE_DEAD, limit.toString())
        ).use { c ->
            while (c.moveToNext()) {
                out += JSONObject()
                    .put("id", c.getString(0))
                    .put("packet", c.getString(1))
                    .put("attempts", c.getInt(2))
                    .put("last_error", c.getString(3) ?: "")
                    .put("last_transport", c.getString(4) ?: "")
                    .put("last_peer", c.getString(5) ?: "")
                    .put("expires_at", c.getLong(6))
            }
        }
        return out
    }
}
