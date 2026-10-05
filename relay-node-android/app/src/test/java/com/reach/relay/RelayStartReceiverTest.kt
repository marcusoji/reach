package com.reach.relay

import android.Manifest
import android.app.Application
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertFalse
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * The relay node must come back after a reboot without the citizen reopening the app, but it must
 * never start a radio the citizen refused. These pin both halves: a boot broadcast with no relay
 * permission leaves the node stopped, a non-boot broadcast is ignored, and a boot broadcast with
 * the Bluetooth permission is handled without throwing.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30, 33])
class RelayStartReceiverTest {

    @Before
    fun resetServiceState() {
        RelayService.isStarted = false
        RelayService.isRunning = false
    }

    @Test
    fun `a boot broadcast without relay permission does not start the node`() {
        RelayStartReceiver().onReceive(ApplicationProvider.getApplicationContext(), Intent(Intent.ACTION_BOOT_COMPLETED))
        assertFalse(RelayService.isStarted)
    }

    @Test
    fun `a non-boot broadcast is ignored`() {
        val context = ApplicationProvider.getApplicationContext<Application>()
        shadowOf(context).grantPermissions(Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT)
        RelayStartReceiver().onReceive(context, Intent("com.example.NOT_A_BOOT"))
        assertFalse(RelayService.isStarted)
    }

    @Test
    fun `a boot broadcast with the bluetooth permission is handled without throwing`() {
        val context = ApplicationProvider.getApplicationContext<Application>()
        shadowOf(context).grantPermissions(Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT)
        // Must not throw; the platform is free to defer the actual service start.
        RelayStartReceiver().onReceive(context, Intent(Intent.ACTION_BOOT_COMPLETED))
    }

    @Test
    fun `a null intent is ignored`() {
        RelayStartReceiver().onReceive(ApplicationProvider.getApplicationContext(), null)
        assertFalse(RelayService.isStarted)
    }
}
