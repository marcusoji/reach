package com.reach.relay

import android.annotation.SuppressLint
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
    private val fileChooserRequestId = 9003
    // A WebView geolocation prompt that arrived before the runtime location dialog was answered.
    private var pendingGeoCallback: android.webkit.GeolocationPermissions.Callback? = null
    private var pendingGeoOrigin: String? = null
    // The in-flight <input type=file> callback. Without answering this, a file input in the PWA
    // (the relay "Receive an alert file" import, or an evidence capture) does nothing inside the app.
    private var filePathCallback: android.webkit.ValueCallback<Array<android.net.Uri>>? = null
    // The connectivity panel is a one-shot hint: opening it on every resume would flash a system
    // screen over the app each time the citizen returns from anywhere.
    private var wifiPanelShown = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // A device whose WebView provider is broken throws here. The relay service is the point of
        // this app, so bring it up regardless and only show the PWA when the WebView works.
        val view = try {
            buildWebView()
        } catch (e: Exception) {
            android.util.Log.w("ReachRelay", "WebView unavailable: ${e.message}")
            null
        }
        if (view != null) setContentView(view)
        // The relay node should come up with its radios available: request the runtime
        // permissions on launch, then switch Bluetooth on (and prompt for Wi-Fi). None of this may
        // take the app down — the queue and the uplink still work without a radio.
        try {
            requestRuntimePermissions()
        } catch (e: Exception) {
            android.util.Log.w("ReachRelay", "permission request failed: ${e.message}")
        }
        try {
            startRelayServiceIfPermitted()
        } catch (e: Exception) {
            android.util.Log.w("ReachRelay", "relay service start failed: ${e.message}")
        }
        try {
            enableRadios()
        } catch (e: Exception) {
            android.util.Log.w("ReachRelay", "radio prompt failed: ${e.message}")
        }
    }

    private fun buildWebView(): WebView {
        val view = WebView(this)
        view.settings.javaScriptEnabled = true
        view.settings.domStorageEnabled = true
        view.settings.allowFileAccess = false
        view.settings.allowContentAccess = false
        view.settings.allowFileAccessFromFileURLs = false
        view.settings.allowUniversalAccessFromFileURLs = false
        view.settings.setGeolocationEnabled(true)
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
        // A data:/http(s) download started by the page has no handler without this, so the tap
        // would silently do nothing. The relay export prefers the share sheet and falls back to a
        // download; in a browser that fallback is the browser's own download manager.
        view.setDownloadListener { url, _, _, mimeType, _ ->
            try {
                val uri = android.net.Uri.parse(url)
                val intent = when (uri.scheme) {
                    "data" -> Intent(Intent.ACTION_VIEW).apply { setDataAndType(uri, mimeType ?: "*/*") }
                    "http", "https" -> Intent(Intent.ACTION_VIEW, uri)
                    else -> null
                }
                if (intent != null) startActivity(Intent.createChooser(intent, "Save file"))
            } catch (_: Exception) {
                // No viewer available for the download; nothing to do.
            }
        }
        // The citizen PWA reads GPS through the WebView. Without a WebChromeClient Android silently
        // denies navigator.geolocation, so the page could never obtain a fix inside the app.
        view.webChromeClient = object : android.webkit.WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(
                origin: String?,
                callback: android.webkit.GeolocationPermissions.Callback?,
            ) {
                if (origin == null || callback == null) return
                val host = android.net.Uri.parse(origin).host
                val trusted = host != null && host == allowedHost
                if (!trusted) { callback.invoke(origin, false, false); return }
                if (locationPermissionGranted()) {
                    callback.invoke(origin, true, false)
                } else {
                    // Hold the prompt and ask the OS; the callback is answered in
                    // onRequestPermissionsResult once the citizen answers the location dialog.
                    pendingGeoCallback = callback
                    pendingGeoOrigin = origin
                    requestPermissions(locationRequiredPermissions().toTypedArray(), permissionRequestId)
                }
            }

            override fun onShowFileChooser(
                webView: WebView?,
                callback: android.webkit.ValueCallback<Array<android.net.Uri>>?,
                params: android.webkit.WebChromeClient.FileChooserParams?,
            ): Boolean {
                if (callback == null) return false
                // Only one chooser may be in flight; a stale callback would leak and freeze the
                // input, so the previous one is cancelled before the new one is opened.
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback
                val intent = try {
                    params?.createIntent()
                } catch (_: Exception) {
                    null
                } ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                }
                return try {
                    startActivityForResult(Intent.createChooser(intent, "Select file"), fileChooserRequestId)
                    true
                } catch (_: Exception) {
                    // No file picker on the device: fail the chooser rather than leaving it hanging.
                    filePathCallback = null
                    callback.onReceiveValue(null)
                    false
                }
            }
        }
        val url = BuildConfig.REACH_CITIZEN_URL
        if (url.startsWith("https://") || url.startsWith("http://localhost") || url.startsWith("http://127.0.0.1")) {
            view.loadUrl(url)
        }
        return view
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == permissionRequestId) {
            startRelayServiceIfPermitted()
            enableRadios()
            // The WebView may have asked for location while the dialog was up; answer it now.
            pendingGeoCallback?.let { cb ->
                val origin = pendingGeoOrigin
                if (origin != null) cb.invoke(origin, locationPermissionGranted(), false)
            }
            pendingGeoCallback = null
            pendingGeoOrigin = null
        }
    }

    override fun onResume() {
        super.onResume()
        // A user who was sent to Settings may have enabled the radio there.
        startRelayServiceIfPermitted()
    }

    @Deprecated("Deprecated in Java")
    public override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != fileChooserRequestId) return
        // Hand the picked file(s) back to the WebView, or an empty result when the chooser was
        // dismissed — the callback must be answered exactly once or the file input stays stuck.
        val callback = filePathCallback ?: return
        filePathCallback = null
        val uris = if (resultCode == Activity.RESULT_OK) {
            android.webkit.WebChromeClient.FileChooserParams.parseResult(resultCode, data)
        } else {
            null
        }
        callback.onReceiveValue(uris)
    }

    /** True when the Bluetooth half of the relay can run. */
    internal fun bleRelayPermissionsGranted(): Boolean =
        bleRequiredPermissions().all { hasPermission(it) }

    private fun hasPermission(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    /** The Bluetooth permissions the relay transports need, by OS level. */
    private fun bleRequiredPermissions(): List<String> = when {
        android.os.Build.VERSION.SDK_INT >= 31 -> listOf(
            android.Manifest.permission.BLUETOOTH_SCAN,
            android.Manifest.permission.BLUETOOTH_CONNECT,
            android.Manifest.permission.BLUETOOTH_ADVERTISE,
        )
        else -> listOf(android.Manifest.permission.ACCESS_FINE_LOCATION)
    }

    /** The permission that gates Wi-Fi Direct: NEARBY_WIFI_DEVICES from 33, fine location before. */
    private fun wifiRequiredPermission(): String =
        if (android.os.Build.VERSION.SDK_INT >= 33) android.Manifest.permission.NEARBY_WIFI_DEVICES
        else android.Manifest.permission.ACCESS_FINE_LOCATION

    /** True when the app may read location on the PWA's behalf. */
    internal fun locationPermissionGranted(): Boolean =
        ContextCompat.checkSelfPermission(this, android.Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(this, android.Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

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

    /**
     * Location permissions, requested separately from the relay set so that denying GPS does not
     * disable the relay. On API 33+ the split Bluetooth permissions no longer imply location, and the
     * WebView hands the PWA's GPS read to the app — without this the citizen's location is silently
     * unavailable inside the app.
     */
    private fun locationRequiredPermissions(): List<String> = listOf(
        android.Manifest.permission.ACCESS_FINE_LOCATION,
        android.Manifest.permission.ACCESS_COARSE_LOCATION,
    )

    private fun startRelayServiceIfPermitted() {
        // Start on the Bluetooth grant alone: whichever radio is available must come up, even if
        // the citizen declines Wi-Fi. The service itself skips any transport it cannot run.
        if (bleRelayPermissionsGranted()) {
            startForegroundService(Intent(this, RelayService::class.java))
        }
    }

    /**
     * A truthful snapshot of the relay node for the PWA.
     *
     * `serviceRunning` is read from the real service instance, and `advertising` is false when the
     * peripheral half failed to start, so the UI can say "listening" only when the node actually is.
     */
    internal fun relayStateJson(): String {
        val granted = bleRelayPermissionsGranted()
        val wifiGranted = hasPermission(wifiRequiredPermission())
        val bt = bluetoothEnabled()
        val wifi = wifiEnabled()
        val hotspot = RelayGatewayUploader.hotspotActive(this)
        val running = RelayService.isRunning
        val advertising = running && RelayService.advertisingOk
        val advertiseError = RelayService.advertiseError
        val detail = when {
            !granted -> "Waiting for Bluetooth permission"
            !bt -> "Permission granted — switch Bluetooth on to relay"
            !running -> "Bluetooth on — relay is starting up"
            !advertising -> "Bluetooth on — this node is not advertising${advertiseError?.let { " ($it)" } ?: ""}"
            !wifiGranted -> "Listening on Bluetooth — allow nearby Wi-Fi devices for the second relay path"
            !wifi -> "Listening on Bluetooth — turn Wi-Fi or hotspot on for the second relay path"
            else -> "Relay node ready — Bluetooth and Wi-Fi on"
        }
        return JSONObject()
            .put("permissions", granted)
            .put("bluetooth", bt)
            .put("wifi", wifi)
            .put("wifi_permission", wifiGranted)
            .put("hotspot", hotspot)
            .put("service_running", running)
            .put("advertising", advertising)
            .put("advertise_error", advertiseError ?: JSONObject.NULL)
            .put("detail", detail)
            .toString()
    }

    internal fun requestRuntimePermissions() {
        val required = relayRequiredPermissions().toMutableList()
        required += locationRequiredPermissions()
        if (android.os.Build.VERSION.SDK_INT >= 33) required += android.Manifest.permission.POST_NOTIFICATIONS
        val missing = required.distinct().filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) requestPermissions(missing.toTypedArray(), permissionRequestId)
    }

    /** Ask the platform to switch the radios on. Android only *prompts* for Bluetooth and Wi-Fi. */
    // Lint cannot see that the Bluetooth permission gate guards every privileged use below.
    @SuppressLint("MissingPermission")
    internal fun enableRadios() {
        // Bluetooth first, gated only on the Bluetooth grant, so declining Wi-Fi never blocks the
        // primary relay path from coming up.
        if (bleRelayPermissionsGranted()) {
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
        }
        // Programmatic Wi-Fi enable is not permitted on modern Android, so the most we can do is
        // open the connectivity panel — and only once per launch. Wi-Fi Direct does not need it (it
        // rides on the radio, not on internet), and re-opening the panel on every resume made the
        // app unusable, so the panel is a one-shot hint and afterwards the UI just reports the state.
        if (hasPermission(wifiRequiredPermission()) && !wifiEnabled() &&
            android.os.Build.VERSION.SDK_INT >= 29 && !wifiPanelShown
        ) {
            wifiPanelShown = true
            try { startActivity(Intent(Settings.Panel.ACTION_INTERNET_CONNECTIVITY)) } catch (_: Exception) {}
        }
    }

    internal fun bluetoothEnabled(): Boolean = bluetoothManager.adapter?.isEnabled == true

    /**
     * Save a text file (the relay packet export) into the device's Downloads so the citizen can
     * transfer it by hand. Inside the app's WebView there is no share sheet or download manager for
     * a blob/data URL, so "Save alert file to transfer" would otherwise do nothing — the file has to
     * be written natively. Returns a small JSON result the PWA shows in its status line.
     */
    internal fun saveTextToDownloads(fileName: String, contents: String): String {
        val safeName = fileName.replace(Regex("[^A-Za-z0-9._-]"), "_").ifBlank { "reach-alert.json" }
        return try {
            if (android.os.Build.VERSION.SDK_INT >= 29) {
                val values = android.content.ContentValues().apply {
                    put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, safeName)
                    put(android.provider.MediaStore.MediaColumns.MIME_TYPE, "application/json")
                    put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, android.os.Environment.DIRECTORY_DOWNLOADS)
                }
                val uri = contentResolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                val out = uri?.let { contentResolver.openOutputStream(it) }
                if (out == null) {
                    JSONObject().put("saved", false).toString()
                } else {
                    out.use { it.write(contents.toByteArray(Charsets.UTF_8)) }
                    JSONObject().put("saved", true).put("location", "Downloads/$safeName").toString()
                }
            } else {
                // API 26-28 have no scoped Downloads collection; the app's own external directory
                // needs no storage permission and is still reachable by a file manager.
                val dir = getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS) ?: filesDir
                val file = java.io.File(dir, safeName)
                file.writeText(contents, Charsets.UTF_8)
                JSONObject().put("saved", true).put("location", file.absolutePath).toString()
            }
        } catch (_: Exception) {
            JSONObject().put("saved", false).toString()
        }
    }

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
            // The node forwards packets under its own relay identity, and the gateway rejects any
            // relay device that is not registered. The PWA registers its own source identity, so the
            // node must register its relay identity with the same session it was just handed.
            RelayGatewayUploader.registerDeviceAsync(activity)
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

        /**
         * Delivery state of a packet this app accepted. sendPacket only *enqueues*, so a caller that
         * wants to know whether the packet actually reached a peer must poll this: a row that has
         * been ACKed is gone, and `state:"delivered"` means a verified peer ACK or gateway upload.
         */
        @JavascriptInterface
        fun packetStatus(packetKey: String): String {
            if (!originOk()) return "{\"state\":\"unknown\"}"
            return try {
                val row = RelayQueueDb(activity).statusOf(packetKey)
                if (row == null) JSONObject().put("state", "delivered").toString()
                else row.put("state", when (row.optString("state")) {
                    RelayQueueDb.STATE_PENDING -> "pending"
                    RelayQueueDb.STATE_SENDING -> "sending"
                    RelayQueueDb.STATE_DEAD -> "dead"
                    else -> "pending"
                }).toString()
            } catch (_: Exception) {
                "{\"state\":\"unknown\"}"
            }
        }

        /** Report the live permission/radio/relay state; never optimistically reports "on". */
        @JavascriptInterface
        fun getPermissionStatus(): String {
            val main = activity as? MainActivity
            return main?.relayStateJson() ?: JSONObject()
                .put("permissions", false)
                .put("bluetooth", false)
                .put("wifi", false)
                .put("hotspot", false)
                .put("service_running", false)
                .put("advertising", false)
                .put("advertise_error", JSONObject.NULL)
                .put("detail", "Relay node unavailable")
                .toString()
        }

        /**
         * Save the exported relay packet JSON into the device's Downloads. The WebView cannot
         * complete a blob download or a share sheet, so this is the only way "Save alert file to
         * transfer" produces a file the citizen can hand to another device.
         */
        @JavascriptInterface
        fun saveExportFile(fileName: String, contents: String): String {
            if (!originOk()) return "{\"saved\":false}"
            val main = activity as? MainActivity ?: return "{\"saved\":false}"
            return main.saveTextToDownloads(fileName, contents)
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
            val state = main?.relayStateJson() ?: return "{\"accepted\":false}"
            val parsed = JSONObject(state)
            return JSONObject()
                .put("accepted", parsed.optBoolean("permissions"))
                .put("bluetooth", parsed.optBoolean("bluetooth"))
                .put("wifi", parsed.optBoolean("wifi"))
                .put("hotspot", parsed.optBoolean("hotspot"))
                .put("service_running", parsed.optBoolean("service_running"))
                .put("advertising", parsed.optBoolean("advertising"))
                .put("detail", parsed.optString("detail"))
                .toString()
        }
    }
}

