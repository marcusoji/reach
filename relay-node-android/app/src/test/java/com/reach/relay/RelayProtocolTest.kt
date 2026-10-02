package com.reach.relay

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The canonical signed string and the JSON field names are the cross-language contract between
 * the Kotlin node, the TypeScript Edge Function and the browser PWA. A divergence here silently
 * breaks every signature check, so the exact bytes and key order are asserted.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class RelayProtocolTest {

    private fun packet() = JSONObject().apply {
        put("v", 2)
        put("k", "pkt-abcdef01")
        put("e", 1800000000000L)
        put("h", 0)
        put("m", 6)
        put("incident_id", JSONObject.NULL)
        put("source_device_id", "device-xyz")
        put("x", "a".repeat(64))
        put("minimal_payload", JSONObject().put("category", "fire").put("priority", "high"))
    }

    @Test
    fun `canonicalSource uses the shared key order and omits x`() {
        val canonical = DeviceIdentity.canonicalSource(packet())
        assertEquals(
            "v=2&k=pkt-abcdef01&e=1800000000000&m=6&incident_id=null&source_device_id=device-xyz&minimal_payload={\"category\":\"fire\",\"priority\":\"high\"}",
            canonical
        )
        // x is the digest of this string, so it must not appear inside it.
        assertTrue(!canonical.contains("&x="))
    }

    @Test
    fun `canonicalRelay includes x and the relay identity`() {
        val p = packet().put("relay_device_id", "relay-node-1")
        assertEquals(
            "v=2&k=pkt-abcdef01&e=1800000000000&h=0&m=6&incident_id=null&source_device_id=device-xyz&x=${"a".repeat(64)}&relay_device_id=relay-node-1&minimal_payload={\"category\":\"fire\",\"priority\":\"high\"}",
            DeviceIdentity.canonicalRelay(p)
        )
    }

    @Test
    fun `nextHop increments h and strips any existing relay envelope`() {
        val p = packet()
            .put("h", 1)
            .put("relay_device_id", "previous-node")
            .put("relay_public_key", "k")
            .put("relay_signature", "s")
            .put("relay_signed_payload", "p")
        val stripped = RelayProtocol.advanceHop(p)
        assertEquals(2, stripped.optInt("h"))
        assertTrue(!stripped.has("relay_device_id"))
        assertTrue(!stripped.has("relay_public_key"))
        assertTrue(!stripped.has("relay_signature"))
        assertTrue(!stripped.has("relay_signed_payload"))
    }

    @Test
    fun `gatewayRelayEnvelope keeps the hop count but replaces the relay identity`() {
        val p = packet().put("h", 2).put("relay_device_id", "old").put("relay_signature", "old")
        val stripped = RelayProtocol.relayEnvelopeFor(p)
        // The hop count must survive: the gateway uses it to decide a relay envelope is required.
        assertEquals(2, stripped.optInt("h"))
        assertTrue(!stripped.has("relay_device_id"))
        assertTrue(!stripped.has("relay_signature"))
    }

    @Test
    fun `validate rejects a version mismatch`() {
        val raw = packet().put("v", 3).toString().toByteArray()
        val threw = try { RelayProtocol.validate(raw); false } catch (_: Exception) { true }
        assertTrue(threw)
    }

    @Test
    fun `validate rejects a short packet hash`() {
        val raw = packet().put("x", "abc").toString().toByteArray()
        val threw = try { RelayProtocol.validate(raw); false } catch (_: Exception) { true }
        assertTrue(threw)
    }

    @Test
    fun `validate rejects an expired packet`() {
        val raw = packet().put("e", System.currentTimeMillis() - 1000).toString().toByteArray()
        val threw = try { RelayProtocol.validate(raw); false } catch (_: Exception) { true }
        assertTrue(threw)
    }

    @Test
    fun `validate rejects a hop count at the limit`() {
        val raw = packet().put("h", 6).toString().toByteArray()
        val threw = try { RelayProtocol.validate(raw); false } catch (_: Exception) { true }
        assertTrue(threw)
    }

    @Test
    fun `validate rejects a max hop above the server ceiling`() {
        val raw = packet().put("m", 7).toString().toByteArray()
        val threw = try { RelayProtocol.validate(raw); false } catch (_: Exception) { true }
        assertTrue(threw)
    }

    @Test
    fun `verifyAck requires the id, the hash and acceptance`() {
        val ack = JSONObject().put("k", "pkt-1").put("x", "h").put("accepted", true)
        assertTrue(RelayProtocol.verifyAck(ack, "pkt-1", "h"))
        assertTrue(!RelayProtocol.verifyAck(ack, "pkt-2", "h"))
        assertTrue(!RelayProtocol.verifyAck(ack, "pkt-1", "other"))
        assertTrue(!RelayProtocol.verifyAck(ack.put("accepted", false), "pkt-1", "h"))
    }

    @Test
    fun `parseAck rejects a non-ACK payload`() {
        val raw = JSONObject().put("type", "NOPE").put("v", 2).put("k", "x").put("x", "y").put("receiver_device_id", "d").toString().toByteArray()
        val threw = try { RelayProtocol.parseAck(raw); false } catch (_: Exception) { true }
        assertTrue(threw)
    }
}
