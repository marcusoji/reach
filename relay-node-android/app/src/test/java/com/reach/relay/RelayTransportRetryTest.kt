package com.reach.relay

import android.Manifest
import android.content.Context
import android.os.Build
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * A relay transport that cannot start yet (permission missing) must report that clearly so the
 * service retries it after the citizen grants access. Before this contract existed, the Wi-Fi
 * listener returned early without binding and the service still treated it as started, so granting
 * Wi-Fi after launch left the second relay path dead until the process was killed.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class RelayTransportRetryTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()

    @Test
    fun `wifi listener reports not-started while the permission is missing`() {
        // Robolectric grants nothing by default, and it provides a Wi-Fi P2P service, so the
        // permission gate is what decides the result.
        assertFalse(WifiDirectRelay(context).startAckServer(context) {})
    }

    @Test
    fun `wifi listener starts once the permission is granted`() {
        shadowOf(ApplicationProvider.getApplicationContext<android.app.Application>())
            .grantPermissions(Manifest.permission.NEARBY_WIFI_DEVICES)
        assertTrue(WifiDirectRelay(context).startAckServer(context) {})
    }
}
