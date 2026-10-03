package com.reach.relay

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat

/**
 * Runtime permission gates for the relay transports.
 *
 * Callers must check the relevant gate before touching privileged Bluetooth /
 * Wi-Fi Direct APIs: on API 31+ the fine-grained BLUETOOTH_* and
 * NEARBY_WIFI_DEVICES permissions apply, below that location is the gate.
 * The platform throws SecurityException if a permission is revoked mid-flight,
 * so transport entry points also fail closed.
 */
internal object Permissions {
    private fun granted(context: Context, permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    fun bleScan(context: Context): Boolean =
        if (Build.VERSION.SDK_INT >= 31) granted(context, Manifest.permission.BLUETOOTH_SCAN)
        else granted(context, Manifest.permission.ACCESS_FINE_LOCATION)

    fun bleConnect(context: Context): Boolean =
        if (Build.VERSION.SDK_INT >= 31) granted(context, Manifest.permission.BLUETOOTH_CONNECT)
        else granted(context, Manifest.permission.ACCESS_FINE_LOCATION)

    fun bleAdvertise(context: Context): Boolean =
        if (Build.VERSION.SDK_INT >= 31) granted(context, Manifest.permission.BLUETOOTH_ADVERTISE)
        else true

    fun wifiDirect(context: Context): Boolean =
        // Wi-Fi Direct rides on NEARBY_WIFI_DEVICES from API 33, but the platform also accepts
        // fine location on 31-32. Requiring NEARBY_WIFI_DEVICES there would always read denied
        // (the permission does not exist before 33) and silently disable the Wi-Fi transport.
        if (Build.VERSION.SDK_INT >= 33) granted(context, Manifest.permission.NEARBY_WIFI_DEVICES)
        else granted(context, Manifest.permission.ACCESS_FINE_LOCATION)
}
