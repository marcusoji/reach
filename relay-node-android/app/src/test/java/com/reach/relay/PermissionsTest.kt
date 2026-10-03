package com.reach.relay

import android.content.Context
import android.os.Build
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The Wi-Fi Direct transport must be gated correctly at every API level.
 *
 * Before API 33 the gate is fine location; NEARBY_WIFI_DEVICES does not exist until 33, so
 * requiring it on 31-32 always read as denied and silently disabled the Wi-Fi relay path.
 */
@RunWith(RobolectricTestRunner::class)
class PermissionsTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()

    @Test
    @Config(sdk = [33])
    fun `wifi direct is denied without a grant on api 33`() {
        // Robolectric grants nothing by default, so the gate must fail closed rather than throw.
        assertFalse(Permissions.wifiDirect(context))
    }

    @Test
    @Config(sdk = [32])
    fun `wifi direct is denied without a grant on api 32`() {
        assertFalse(Permissions.wifiDirect(context))
    }

    @Test
    @Config(sdk = [30])
    fun `wifi direct is denied without a grant on api 30`() {
        assertFalse(Permissions.wifiDirect(context))
    }

    @Test
    @Config(sdk = [30])
    fun `ble advertise needs no runtime permission below api 31`() {
        // Pre-31 Bluetooth advertising needs no runtime permission; only scan/connect do.
        assertTrue(Permissions.bleAdvertise(context))
    }

    @Test
    @Config(sdk = [33])
    fun `ble advertise is gated on api 33`() {
        assertFalse(Permissions.bleAdvertise(context))
    }
}
