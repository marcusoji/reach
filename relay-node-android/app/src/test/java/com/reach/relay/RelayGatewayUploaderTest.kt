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
import java.net.ServerSocket
import java.time.Instant

/**
 * The gateway body is the server contract for /relay/packets. The hop count and expiry carry
 * over verbatim, and a direct upload uses transport "native" so the server can tell it apart
 * from a browser-originated packet.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class RelayGatewayUploaderTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()

    private fun directPacket() = JSONObject()
        .put("v", 2)
        .put("k", "pkt-abcdef01")
        .put("x", "a".repeat(64))
        .put("h", 0)
        .put("m", 6)
        .put("e", Instant.parse("2027-01-15T08:00:00Z").toEpochMilli())
        .put("incident_id", JSONObject.NULL)
        .put("source_device_id", "device-xyz")
        .put("source_public_key", "spki")
        .put("source_signature", "sig")
        .put("source_signed_payload", "v=2&k=pkt-abcdef01")
        .put("minimal_payload", JSONObject().put("category", "fire"))

    /** One-shot HTTP responder: captures the request, replies with [status]. */
    private fun withServer(
        status: Int,
        capture: (auth: String, body: String) -> Unit,
        pathCapture: (path: String) -> Unit = {},
        block: (base: String) -> Unit,
    ) {
        val server = ServerSocket(0)
        val thread = Thread {
            try {
                val sock = server.accept()
                val reader = sock.getInputStream().bufferedReader()
                val requestLine = reader.readLine() // request line
                pathCapture(requestLine?.split(" ")?.getOrNull(1) ?: "")
                var contentLength = 0
                var auth = ""
                var line = reader.readLine()
                while (line != null && line.isNotEmpty()) {
                    val lower = line.lowercase()
                    if (lower.startsWith("content-length:")) contentLength = line.substringAfter(":").trim().toInt()
                    if (lower.startsWith("authorization:")) auth = line.substringAfter(":").trim()
                    line = reader.readLine()
                }
                val body = if (contentLength > 0) CharArray(contentLength).also { reader.read(it) }.concatToString() else ""
                capture(auth, body)
                val resp = "{}"
                val out = sock.getOutputStream()
                out.write("HTTP/1.1 $status X\r\nContent-Length: ${resp.length}\r\nConnection: close\r\n\r\n$resp".toByteArray())
                out.flush()
                sock.close()
            } catch (_: Exception) {
            }
        }
        thread.isDaemon = true
        thread.start()
        try {
            block("http://127.0.0.1:${server.localPort}")
        } finally {
            server.close()
        }
    }

    @Test
    fun `isConfigured is false before a session is set`() {
        assertFalse(RelayGatewayUploader.isConfigured(context))
    }

    @Test
    fun `configure accepts an https gateway`() {
        RelayGatewayUploader.configure(context, "https://example.supabase.co/functions/v1/api", "token", "anon")
        assertTrue(RelayGatewayUploader.isConfigured(context))
    }

    @Test
    fun `configure rejects a cleartext non-local gateway`() {
        RelayGatewayUploader.configure(context, "http://evil.example.com/api", "token", "anon")
        assertFalse(RelayGatewayUploader.isConfigured(context))
    }

    @Test
    fun `configure rejects an empty token`() {
        RelayGatewayUploader.configure(context, "https://example.supabase.co/api", "", "anon")
        assertFalse(RelayGatewayUploader.isConfigured(context))
    }

    @Test
    fun `buildBody maps a direct packet without a relay envelope`() {
        val body = RelayGatewayUploader.buildBody(directPacket())
        assertEquals("pkt-abcdef01", body.optString("packet_key"))
        assertEquals("a".repeat(64), body.optString("packet_hash"))
        assertEquals("device-xyz", body.optString("source_device_id"))
        assertEquals(0, body.optInt("hop_count"))
        assertEquals(6, body.optInt("max_hops"))
        assertEquals("native", body.optString("transport"))
        assertEquals(Instant.ofEpochMilli(directPacket().optLong("e")).toString(), body.optString("ttl_expires_at"))
        assertTrue(body.isNull("incident_id"))
        assertEquals("fire", body.optJSONObject("minimal_payload").optString("category"))
        // A direct packet carries no relay envelope.
        assertEquals("", body.optString("relay_device_id"))
        assertEquals("", body.optString("relay_signature"))
    }

    @Test
    fun `buildBody preserves a relay envelope already on the packet`() {
        // A packet that arrived over the radio carries the forwarding node's envelope. This node is
        // only uploading it, so the envelope must survive verbatim rather than be re-signed here.
        val relayed = directPacket()
            .put("h", 2)
            .put("relay_device_id", "node-7")
            .put("relay_public_key", "relay-spki")
            .put("relay_signature", "relay-sig")
            .put("relay_signed_payload", "v=2&k=pkt-abcdef01&h=2")
        val body = RelayGatewayUploader.buildBody(relayed)
        assertEquals(2, body.optInt("hop_count"))
        assertEquals("node-7", body.optString("relay_device_id"))
        assertEquals("relay-spki", body.optString("relay_public_key"))
        assertEquals("relay-sig", body.optString("relay_signature"))
        assertEquals("v=2&k=pkt-abcdef01&h=2", body.optString("relay_signed_payload"))
    }

    @Test
    fun `upload posts the body and returns true on 200`() {
        RelayGatewayUploader.connectivityProbe = { true }
        var auth = ""
        var body = ""
        withServer(200, { a, b -> auth = a; body = b }) { base ->
            RelayGatewayUploader.configure(context, base, "session-token", "anon-key")
            assertTrue(RelayGatewayUploader.upload(context, directPacket()))
        }
        assertEquals("Bearer session-token", auth)
        assertTrue(body.contains("\"packet_key\":\"pkt-abcdef01\""))
        assertTrue(body.contains("\"transport\":\"native\""))
    }

    @Test
    fun `upload returns false on a non-2xx response so the packet is retried`() {
        RelayGatewayUploader.connectivityProbe = { true }
        withServer(503, { _, _ -> }) { base ->
            RelayGatewayUploader.configure(context, base, "t", "a")
            assertFalse(RelayGatewayUploader.upload(context, directPacket()))
        }
    }

    @Test
    fun `upload returns false when there is no connectivity`() {
        RelayGatewayUploader.connectivityProbe = { false }
        withServer(200, { _, _ -> }) { base ->
            RelayGatewayUploader.configure(context, base, "t", "a")
            assertFalse(RelayGatewayUploader.upload(context, directPacket()))
        }
    }

    @Test
    fun `registerDevice posts this node's relay identity and returns true on 200`() {
        RelayGatewayUploader.connectivityProbe = { true }
        var auth = ""
        var body = ""
        var path = ""
        withServer(200, { a, b -> auth = a; body = b }, pathCapture = { p -> path = p }) { base ->
            RelayGatewayUploader.configure(context, base, "session-token", "anon-key")
            assertTrue(RelayGatewayUploader.registerDevice(context))
        }
        // The relay identity the gateway must know is the node's own device id/public key, and it is
        // the endpoint that `ingest_relay_packet_service` reads to authorize a relay envelope.
        // Parse rather than substring-match: org.json escapes "/" as "\/" in the wire body.
        val sent = JSONObject(body)
        assertEquals("/devices/register", path)
        assertEquals("Bearer session-token", auth)
        assertEquals(DeviceIdentity.deviceId(), sent.optString("device_id"))
        assertEquals(DeviceIdentity.publicKeyB64(), sent.optString("public_key"))
        assertEquals("android", sent.optString("platform"))
    }

    @Test
    fun `registerDevice is skipped when no session was handed over`() {
        assertFalse(RelayGatewayUploader.registerDevice(context))
    }
}
