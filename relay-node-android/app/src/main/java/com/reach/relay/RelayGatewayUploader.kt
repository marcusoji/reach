package com.reach.relay

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.util.Log
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant

/**
 * Uploads a validated relay packet to the REACH gateway (Edge Function /relay/packets).
 *
 * A node that has connectivity drains its queue through here; a node without connectivity
 * leaves the packet for a radio hop. A packet that arrived over the radio already carries the
 * forwarding node's relay envelope, and the gateway refuses a non-zero hop count that no relay
 * envelope vouches for — so the envelope is uploaded as-is rather than re-signed here.
 */
object RelayGatewayUploader {
    private const val TAG = "ReachRelay"
    private const val PREFS = "reach-relay-gateway"
    private const val KEY_URL = "api_url"
    private const val KEY_TOKEN = "access_token"
    private const val KEY_ANON = "anon_key"
    private const val TIMEOUT_MS = 15_000

    /** Store the gateway session handed over by the PWA bridge. Invalid input is ignored. */
    fun configure(context: Context, apiUrl: String, accessToken: String, anonKey: String) {
        if (!isAllowedUrl(apiUrl) || accessToken.isBlank()) return
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_URL, apiUrl.trimEnd('/'))
            .putString(KEY_TOKEN, accessToken)
            .putString(KEY_ANON, anonKey)
            .apply()
    }

    /**
     * Register this node's relay identity with the gateway.
     *
     * A forwarded packet carries a relay envelope signed with this node's key, and
     * `ingest_relay_packet_service` rejects any relay whose `relay_device_id`/`relay_public_key`
     * is not an active `device_registrations` row ("Unregistered or revoked relay device"). The
     * PWA registers its own source identity on sign-in, but the native node never registered its
     * relay identity, so every packet it forwarded was refused — the relay could receive packets
     * and never deliver one. Registration is idempotent (`on conflict(device_id) do update`), so
     * re-registering on each session configure/refresh is safe.
     *
     * Blocking; call from a background thread via [registerDeviceAsync].
     */
    fun registerDevice(context: Context): Boolean {
        val (base, token, anon) = config(context) ?: return false
        if (!connectivityProbe(context)) return false
        val body = try {
            JSONObject()
                .put("device_id", DeviceIdentity.deviceId())
                .put("public_key", DeviceIdentity.publicKeyB64())
                .put("platform", "android")
                .put(
                    "metadata",
                    JSONObject()
                        .put("transport", "native-relay")
                        .put("protocol_version", RelayProtocol.PROTOCOL_VERSION)
                )
                .toString()
        } catch (e: Exception) {
            Log.w(TAG, "device registration body build failed: ${e.message}")
            return false
        }
        return try {
            val conn = (URL("$base/devices/register").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = TIMEOUT_MS
                readTimeout = TIMEOUT_MS
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Authorization", "Bearer $token")
                if (anon.isNotBlank()) setRequestProperty("apikey", anon)
            }
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            try { (if (code in 200..299) conn.inputStream else conn.errorStream)?.use { it.readBytes() } } catch (_: Exception) {}
            conn.disconnect()
            code in 200..299
        } catch (e: Exception) {
            Log.w(TAG, "device registration failed: ${e.message}")
            false
        }
    }

    /** Register the node's relay identity off the main thread; never blocks a bridge call. */
    fun registerDeviceAsync(context: Context) {
        val app = context.applicationContext
        Thread {
            if (registerDevice(app)) registered = true
        }.apply { isDaemon = true; name = "reach-register-device"; start() }
    }

    fun isConfigured(context: Context): Boolean = config(context) != null

    private fun config(context: Context): Triple<String, String, String>? {
        val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val url = prefs.getString(KEY_URL, null) ?: return null
        val token = prefs.getString(KEY_TOKEN, null) ?: return null
        if (!isAllowedUrl(url) || token.isBlank()) return null
        return Triple(url, token, prefs.getString(KEY_ANON, "") ?: "")
    }

    private fun isAllowedUrl(url: String): Boolean =
        url.startsWith("https://") || url.startsWith("http://localhost") || url.startsWith("http://127.0.0.1")

    private fun hasNetwork(context: Context): Boolean {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
        val net = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(net) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    /**
     * Whether a hotspot (or any local-only link) is up. This is a transport hint for the UI, not a
     * gateway path: an emergency packet is only delivered when a real internet-capable network
     * reaches the gateway.
     */
    fun hotspotActive(context: Context): Boolean {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
        return cm.allNetworks.any { net ->
            val caps = cm.getNetworkCapabilities(net) ?: return@any false
            !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))
        }
    }

    /** Overridable so tests can drive the upload path without a real network. */
    internal var connectivityProbe: (Context) -> Boolean = { hasNetwork(it) }

    /**
     * Whether a gateway upload can plausibly succeed right now. The drain loop uses this so that a
     * node with a configured gateway but no internet falls back to the radio hop instead of
     * retrying an upload that cannot happen — otherwise "send to REACH" with no signal never tries
     * Bluetooth or Wi-Fi Direct at all.
     */
    fun hasConnectivity(context: Context): Boolean = connectivityProbe(context)

    /** True only on a 2xx response; any other outcome leaves the packet queued for retry. */
    fun upload(context: Context, packet: JSONObject): Boolean {
        val (base, token, anon) = config(context) ?: return false
        if (!connectivityProbe(context)) return false
        val body = try {
            buildBody(packet).toString()
        } catch (e: Exception) {
            Log.w(TAG, "gateway body build failed: ${e.message}")
            return false
        }
        val delivered = try {
            val conn = (URL("$base/relay/packets").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = TIMEOUT_MS
                readTimeout = TIMEOUT_MS
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Authorization", "Bearer $token")
                if (anon.isNotBlank()) setRequestProperty("apikey", anon)
            }
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            try { (if (code in 200..299) conn.inputStream else conn.errorStream)?.use { it.readBytes() } } catch (_: Exception) {}
            conn.disconnect()
            code in 200..299
        } catch (e: Exception) {
            Log.w(TAG, "gateway upload failed: ${e.message}")
            false
        }
        // A relayed packet is only accepted from a registered relay identity. If the node's session
        // was restored from prefs without a fresh bridge handoff, the first uplink is refused as
        // "Unregistered or revoked relay device"; register once, then let the next drain retry the
        // upload with a registered identity. The happy path pays no extra round trip.
        if (!delivered && !registered && registerDevice(context)) registered = true
        return delivered
    }

    /** Register at most once per process; guards the fallback registration on the upload path. */
    @Volatile private var registered = false

    /** Map the stored radio packet to the /relay/packets request body.
     *
     * A packet that arrived over the radio already carries a relay envelope from the node that
     * forwarded it. This node is only uploading it, so the envelope is preserved verbatim: signing
     * a new envelope here would stamp this device as the relay of a hop it did not make, and the
     * server's relay-institution attribution would point at the wrong node.
     */
    internal fun buildBody(packet: JSONObject): JSONObject {
        val hops = packet.optInt("h", 0)
        val signed = if (hops > 0 && packet.optString("relay_device_id").isBlank()) RelayProtocol.gatewayRelayEnvelope(packet) else packet
        return JSONObject()
            .put("v", signed.optInt("v", RelayProtocol.PROTOCOL_VERSION))
            .put("packet_key", signed.optString("k"))
            .put("packet_hash", signed.optString("x"))
            .put("incident_id", if (signed.isNull("incident_id")) JSONObject.NULL else signed.opt("incident_id"))
            .put("source_device_id", signed.optString("source_device_id"))
            .put("source_public_key", signed.optString("source_public_key"))
            .put("source_signature", signed.optString("source_signature"))
            .put("source_signed_payload", signed.optString("source_signed_payload"))
            .put("relay_device_id", signed.optString("relay_device_id"))
            .put("relay_public_key", signed.optString("relay_public_key"))
            .put("relay_signature", signed.optString("relay_signature"))
            .put("relay_signed_payload", signed.optString("relay_signed_payload"))
            .put("hop_count", hops)
            .put("max_hops", signed.optInt("m", RelayProtocol.MAX_HOPS))
            .put("ttl_expires_at", Instant.ofEpochMilli(signed.optLong("e")).toString())
            .put("transport", "native")
            .put("minimal_payload", signed.optJSONObject("minimal_payload") ?: JSONObject())
    }
}
