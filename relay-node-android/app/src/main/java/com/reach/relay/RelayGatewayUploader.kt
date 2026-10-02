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
 * leaves the packet for a radio hop. A packet that already travelled a hop is wrapped in this
 * device's relay envelope, because the gateway refuses a non-zero hop count that no relay
 * envelope vouches for.
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

    /** Overridable so tests can drive the upload path without a real network. */
    internal var connectivityProbe: (Context) -> Boolean = { hasNetwork(it) }

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
        return try {
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
    }

    /** Map the stored radio packet to the /relay/packets request body. */
    internal fun buildBody(packet: JSONObject): JSONObject {
        val hops = packet.optInt("h", 0)
        val signed = if (hops > 0) RelayProtocol.gatewayRelayEnvelope(packet) else packet
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
