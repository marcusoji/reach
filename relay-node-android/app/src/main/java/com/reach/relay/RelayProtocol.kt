package com.reach.relay

import android.util.Base64
import org.json.JSONObject
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

object RelayProtocol {
    const val SERVICE_UUID = "6b4f1c20-9f4a-4f6e-9c2d-1a2b3c4d5e6f"
    const val DATA_UUID = "6b4f1c21-9f4a-4f6e-9c2d-1a2b3c4d5e6f"
    const val ACK_UUID = "6b4f1c22-9f4a-4f6e-9c2d-1a2b3c4d5e6f"
    const val PROTOCOL_VERSION = 2
    const val MAX_HOPS = 6
    const val TTL_MS = 30 * 60 * 1000L // 30 minutes — must match server
    const val MAX_PACKET_BYTES = 48 * 1024
    const val ACK_TIMEOUT_MS = 12_000L
    // ATT payload for a write is (MTU - 3). 20 is the safe floor at the BLE default MTU of 23;
    // the ceiling caps what a peer may grant. Fragments are sized from the negotiated MTU.
    const val REQUESTED_MTU = 517
    const val MAX_FRAGMENT = 512

    fun validate(raw: ByteArray): JSONObject {
        require(raw.size in 32..MAX_PACKET_BYTES) { "Invalid packet size" }
        val o = JSONObject(String(raw, Charsets.UTF_8))
        require(o.optInt("v") == PROTOCOL_VERSION) { "Unsupported packet version" }
        require(o.optString("k").length in 8..160) { "Missing packet key" }
        require(o.optString("x").length == 64) { "Missing packet hash" }
        val now = System.currentTimeMillis()
        val expires = o.optLong("e")
        require(expires > 0 && now <= expires) { "Packet expired" }
        // Cap TTL: reject packets that claim more than MAX TTL from now-ish creation window
        val maxExpiry = now + TTL_MS + 60_000L
        require(expires <= maxExpiry) { "TTL exceeds maximum" }
        val max = o.optInt("m", MAX_HOPS)
        val hops = o.optInt("h", 0)
        // Never trust client max above server constant
        require(max in 1..MAX_HOPS) { "Invalid max hops" }
        require(hops in 0 until max) { "Hop limit reached" }
        verify(o, o.optString("source_public_key"), o.optString("source_signature"), o.optString("source_signed_payload"))
        if (o.optString("relay_device_id").isNotBlank()) {
            verify(o, o.optString("relay_public_key"), o.optString("relay_signature"), o.optString("relay_signed_payload"), relay = true)
        }
        val expected = sha256(DeviceIdentity.canonicalSource(o))
        require(expected == o.optString("x")) { "Packet fingerprint mismatch" }
        return o
    }

    private fun verify(o: JSONObject, keyB64: String, sigB64: String, signed: String, relay: Boolean = false) {
        require(keyB64.isNotBlank() && sigB64.isNotBlank() && signed.isNotBlank()) { "Missing packet signature" }
        val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.decode(keyB64, Base64.DEFAULT)))
        val s = Signature.getInstance("SHA256withECDSA")
        s.initVerify(key)
        s.update(signed.toByteArray(Charsets.UTF_8))
        require(s.verify(Base64.decode(sigB64, Base64.DEFAULT))) {
            if (relay) "Invalid relay signature" else "Invalid source signature"
        }
    }

    fun newPacket(payload: JSONObject): JSONObject {
        val p = JSONObject(payload.toString())
        val now = System.currentTimeMillis()
        p.put("v", PROTOCOL_VERSION)
        p.put("k", p.optString("k").ifBlank { java.util.UUID.randomUUID().toString() })
        p.put("e", now + TTL_MS)
        p.put("h", 0)
        p.put("m", MAX_HOPS) // immutable server/client max
        p.put("source_device_id", DeviceIdentity.deviceId())
        p.put("source_public_key", DeviceIdentity.publicKeyB64())
        p.put("x", sha256(DeviceIdentity.canonicalSource(p)))
        return DeviceIdentity.signSourcePacket(p)
    }

    /** Pure hop advance: increments h and strips any relay envelope inherited from a prior hop. */
    fun advanceHop(o: JSONObject): JSONObject {
        val p = JSONObject(o.toString())
        val hops = p.optInt("h") + 1
        require(hops < p.optInt("m", MAX_HOPS).coerceAtMost(MAX_HOPS)) { "Hop limit" }
        p.put("h", hops)
        stripRelayEnvelope(p)
        return p
    }

    fun nextHop(o: JSONObject): JSONObject = DeviceIdentity.signRelayPacket(advanceHop(o))

    /**
     * Pure form of a direct-to-gateway relay envelope: keeps the hop count but drops any relay
     * identity so this node can sign its own. The packet's `h` already reflects the radio hops
     * it travelled to reach this node, so no hop is added here.
     */
    fun relayEnvelopeFor(o: JSONObject): JSONObject {
        val p = JSONObject(o.toString())
        stripRelayEnvelope(p)
        return p
    }

    /**
     * Sign this device as the relay for a direct-to-gateway upload without advancing the hop
     * count. The gateway requires a relay envelope whenever h > 0, so one must be present even
     * though this node adds no hop.
     */
    fun gatewayRelayEnvelope(o: JSONObject): JSONObject = DeviceIdentity.signRelayPacket(relayEnvelopeFor(o))

    private fun stripRelayEnvelope(p: JSONObject) {
        p.remove("relay_signature")
        p.remove("relay_signed_payload")
        p.remove("relay_device_id")
        p.remove("relay_public_key")
    }

    /** ACK after receiver validates + persists. */
    fun buildAck(
        packetId: String,
        packetHash: String,
        accepted: Boolean,
        reason: String = ""
    ): ByteArray {
        val ack = JSONObject()
            .put("type", "ACK")
            .put("v", PROTOCOL_VERSION)
            .put("k", packetId)
            .put("x", packetHash)
            .put("accepted", accepted)
            .put("reason", reason)
            .put("receiver_device_id", DeviceIdentity.deviceId())
            .put("ts", System.currentTimeMillis())
        return ack.toString().toByteArray(Charsets.UTF_8)
    }

    fun parseAck(raw: ByteArray): JSONObject {
        require(raw.size in 16..4096) { "Invalid ACK size" }
        val o = JSONObject(String(raw, Charsets.UTF_8))
        require(o.optString("type") == "ACK") { "Not an ACK" }
        require(o.optInt("v") == PROTOCOL_VERSION) { "ACK version mismatch" }
        require(o.optString("k").isNotBlank()) { "ACK missing packet id" }
        require(o.optString("x").length == 64) { "ACK missing hash" }
        require(o.optString("receiver_device_id").isNotBlank()) { "ACK missing receiver" }
        return o
    }

    fun verifyAck(ack: JSONObject, expectedId: String, expectedHash: String): Boolean {
        if (ack.optString("k") != expectedId) return false
        if (ack.optString("x") != expectedHash) return false
        if (!ack.optBoolean("accepted", false)) return false
        return true
    }

    private fun sha256(s: String): String =
        MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }
}
