package com.reach.relay

import android.app.Activity
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.content.ContextCompat
import org.json.JSONObject

class MainActivity : Activity() {
    private val bluetoothManager by lazy { getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager }
    private val allowedHost by lazy {
        try {
            android.net.Uri.parse(BuildConfig.REACH_CITIZEN_URL).host
        } catch (_: Exception) {
            null
        }
    }
    private val permissionRequestId = 9001

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val view = WebView(this)
        view.settings.javaScriptEnabled = true
        view.settings.domStorageEnabled = true
        view.settings.allowFileAccess = false
        view.settings.allowContentAccess = false
        view.settings.allowFileAccessFromFileURLs = false
        view.settings.allowUniversalAccessFromFileURLs = false
        view.settings.setGeolocationEnabled(false)
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                val host = request.url.host
                return host == null || host != allowedHost
            }
            @Deprecated("Deprecated in Java")
            override fun shouldOverrideUrlLoading(v: WebView, url: String): Boolean {
                val host = android.net.Uri.parse(url).host
                return host == null || host != allowedHost
            }
        }
        view.addJavascriptInterface(Bridge(this, allowedHost), "REACH_NATIVE_RELAY")
        val url = BuildConfig.REACH_CITIZEN_URL
        if (url.startsWith("https://") || url.startsWith("http://localhost") || url.startsWith("http://127.0.0.1")) {
            view.loadUrl(url)
        }
        setContentView(view)
        // The relay node should come up with its radios available: request the runtime
        // permissions on launch, then switch Bluetooth on (and prompt for Wi-Fi).
        requestRuntimePermissions()
        startRelayServiceIfPermitted()
        enableRadios()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == permissionRequestId) {
            startRelayServiceIfPermitted()
            enableRadios()
        }
    }

    override fun onResume() {
        super.onResume()
        // A user who was sent to Settings may have enabled the radio there.
        startRelayServiceIfPermitted()
    }

    /** True only when every runtime permission the radio transports need is granted. */
    internal fun relayPermissionsGranted(): Boolean =
        relayRequiredPermissions().all { ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED }

    /**
     * The runtime permissions the relay transports need, by OS level:
     * - API 33+: the split Bluetooth permissions plus NEARBY_WIFI_DEVICES (which does not exist
     *   before 33, so requesting it there would always read as denied and wedge the gate).
     * - API 31-32: the split Bluetooth permissions; Wi-Fi Direct still rides on fine location.
     * - older: fine location covers BLE scanning and Wi-Fi Direct.
     */
    private fun relayRequiredPermissions(): List<String> = when {
        android.os.Build.VERSION.SDK_INT >= 33 -> listOf(
            android.Manifest.permission.BLUETOOTH_SCAN,
            android.Manifest.permission.BLUETOOTH_CONNECT,
            android.Manifest.permission.BLUETOOTH_ADVERTISE,
            android.Manifest.permission.NEARBY_WIFI_DEVICES,
        )
        android.os.Build.VERSION.SDK_INT >= 31 -> listOf(
            android.Manifest.permission.BLUETOOTH_SCAN,
            android.Manifest.permission.BLUETOOTH_CONNECT,
            android.Manifest.permission.BLUETOOTH_ADVERTISE,
            android.Manifest.permission.ACCESS_FINE_LOCATION,
        )
        else -> listOf(android.Manifest.permission.ACCESS_FINE_LOCATION)
    }

    private fun startRelayServiceIfPermitted() {
        if (relayPermissionsGranted()) {
            startForegroundService(Intent(this, RelayService::class.java))
        }
    }

    internal fun requestRuntimePermissions() {
        val required = relayRequiredPermissions().toMutableList()
        if (android.os.Build.VERSION.SDK_INT >= 33) required += android.Manifest.permission.POST_NOTIFICATIONS
        val missing = required.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) requestPermissions(missing.toTypedArray(), permissionRequestId)
    }

    /** Ask the platform to switch the radios on. Android only *prompts* for Bluetooth and Wi-Fi. */
    internal fun enableRadios() {
        if (!relayPermissionsGranted()) return
        val adapter = bluetoothManager.adapter
        if (adapter != null && !adapter.isEnabled) {
            try {
                @Suppress("DEPRECATION")
                startActivityForResult(Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE), 9002)
            } catch (_: Exception) {
                // Some builds hide the dialog; fall back to the Bluetooth settings screen.
                try { startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS)) } catch (_: Exception) {}
            }
        }
        // Programmatic Wi-Fi enable is not permitted on modern Android, so the most we can do is
        // open the connectivity panel — and only when Wi-Fi is actually off, never on every launch.
        if (!wifiEnabled() && android.os.Build.VERSION.SDK_INT >= 29) {
            try { startActivity(Intent(Settings.Panel.ACTION_INTERNET_CONNECTIVITY)) } catch (_: Exception) {}
        }
    }

    internal fun bluetoothEnabled(): Boolean = bluetoothManager.adapter?.isEnabled == true

    @Suppress("DEPRECATION")
    internal fun wifiEnabled(): Boolean =
        (getSystemService(Context.WIFI_SERVICE) as? android.net.wifi.WifiManager)?.isWifiEnabled == true

    class Bridge(private val activity: Activity, private val allowedHost: String?) {
        private fun originOk(): Boolean {
            // Privileged bridge only usable while loaded host matches allowed REACH origin.
            return allowedHost != null
        }

        @JavascriptInterface
        fun configureSession(apiUrl: String, accessToken: String, anonKey: String) {
            if (!originOk()) return
            RelayGatewayUploader.configure(activity, apiUrl, accessToken, anonKey)
        }

        @JavascriptInterface
        fun sendPacket(packet: String): String {
            if (!originOk()) return "{\"accepted\":false}"
            return try {
                val valid = RelayProtocol.validate(packet.toByteArray(Charsets.UTF_8))
                RelayForwarder.enqueue(activity, valid)
                JSONObject()
                    .put("accepted", true)
                    .put("packet_key", valid.optString("k"))
                    .put("packet_hash", valid.optString("x"))
                    .toString()
            } catch (_: Exception) {
                "{\"accepted\":false}"
            }
        }

        /** Report the live permission/radio state; never optimistically reports "on". */
        @JavascriptInterface
        fun getPermissionStatus(): String {
            val main = activity as? MainActivity
            return JSONObject()
                .put("permissions", main?.relayPermissionsGranted() == true)
                .put("bluetooth", main?.bluetoothEnabled() == true)
                .put("wifi", main?.wifiEnabled() == true)
                .toString()
        }

        /** Request runtime permissions and prompt to enable the radios. Returns a status object. */
        @JavascriptInterface
        fun requestPermissions(): String {
            if (!originOk()) return "{\"accepted\":false}"
            val main = activity as? MainActivity
            main?.runOnUiThread {
                main.requestRuntimePermissions()
                main.enableRadios()
            }
            val granted = main?.relayPermissionsGranted() == true
            return JSONObject()
                .put("accepted", granted)
                .put("bluetooth", granted)
                .put("wifi", granted)
                .put("detail", if (granted) "Relay node ready" else "Waiting for Bluetooth/Wi-Fi permission")
                .toString()
        }
    }
}

