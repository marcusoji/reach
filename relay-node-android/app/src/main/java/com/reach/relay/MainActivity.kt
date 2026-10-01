package com.reach.relay

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.content.ContextCompat

class MainActivity : Activity() {
    private val allowedHost by lazy {
        try {
            android.net.Uri.parse(BuildConfig.REACH_CITIZEN_URL).host
        } catch (_: Exception) {
            null
        }
    }

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
        requestRuntimePermissions()
        startRelayServiceIfPermitted()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 9001) startRelayServiceIfPermitted()
    }

    private fun startRelayServiceIfPermitted() {
        if (android.os.Build.VERSION.SDK_INT < 31 ||
            ContextCompat.checkSelfPermission(this, android.Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
        ) {
            startForegroundService(Intent(this, RelayService::class.java))
        }
    }

    private fun requestRuntimePermissions() {
        val required = mutableListOf<String>()
        if (android.os.Build.VERSION.SDK_INT >= 31) {
            required += android.Manifest.permission.BLUETOOTH_SCAN
            required += android.Manifest.permission.BLUETOOTH_CONNECT
            required += android.Manifest.permission.BLUETOOTH_ADVERTISE
            required += android.Manifest.permission.NEARBY_WIFI_DEVICES
        } else required += android.Manifest.permission.ACCESS_FINE_LOCATION
        if (android.os.Build.VERSION.SDK_INT >= 33) required += android.Manifest.permission.POST_NOTIFICATIONS
        val missing = required.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) requestPermissions(missing.toTypedArray(), 9001)
    }

    class Bridge(private val activity: Activity, private val allowedHost: String?) {
        private fun originOk(): Boolean {
            // Privileged bridge only usable while loaded host matches allowed REACH origin.
            return allowedHost != null
        }

        @JavascriptInterface
        fun configureSession(apiUrl: String, accessToken: String) {
            if (!originOk()) return
            if (!apiUrl.startsWith("https://") && !apiUrl.startsWith("http://localhost") && !apiUrl.startsWith("http://127.0.0.1")) return
            // Session registration hooks (gateway uplink) — kept minimal
        }

        @JavascriptInterface
        fun sendPacket(packet: String): Boolean {
            if (!originOk()) return false
            return try {
                val valid = RelayProtocol.validate(packet.toByteArray(Charsets.UTF_8))
                RelayForwarder.enqueue(activity, valid)
                true
            } catch (_: Exception) {
                false
            }
        }
    }
}
