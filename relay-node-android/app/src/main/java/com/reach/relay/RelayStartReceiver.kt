package com.reach.relay

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * Restart the relay node after a reboot or an app update.
 *
 * "Active in the background" has to survive the phone restarting: without this, the foreground
 * service is only ever started from [MainActivity.onCreate], so after a reboot the node silently
 * stops carrying packets until the citizen happens to open the app again — and a citizen with no
 * internet is exactly the person who cannot be told to reopen it. The receiver does nothing when
 * no relay permission is held, so it never starts a radio the citizen refused, and it never throws
 * out of a broadcast (a crash here would surface as an app crash on every boot).
 */
class RelayStartReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_MY_PACKAGE_REPLACED &&
            action != "android.intent.action.QUICKBOOT_POWERON"
        ) return
        if (!Permissions.bleAdvertise(context) && !Permissions.wifiDirect(context)) return
        try {
            val service = Intent(context, RelayService::class.java)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(service) else context.startService(service)
        } catch (e: Exception) {
            Log.w("ReachRelay", "relay restart on boot failed: ${e.message}")
        }
    }
}
