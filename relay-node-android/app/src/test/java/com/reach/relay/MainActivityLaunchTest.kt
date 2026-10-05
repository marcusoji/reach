package com.reach.relay

import android.os.Build
import androidx.test.core.app.ApplicationProvider
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Launch smoke test: the activity and the foreground service must come up without throwing on the
 * main thread at every supported API level. This is what catches a launch crash before a physical
 * device does.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [26, 30, 31, 33, 34])
class MainActivityLaunchTest {

    @Test
    fun `activity launches without throwing`() {
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        controller.pause().stop().destroy()
    }

    @Test
    fun `relay state json is always well formed`() {
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        val activity = controller.get()
        val json = activity.relayStateJson()
        org.json.JSONObject(json) // must parse
        controller.destroy()
    }

    @Test
    fun `relay service starts without throwing`() {
        val controller = Robolectric.buildService(RelayService::class.java).create()
        controller.destroy()
    }

    @Test
    fun `bridge status never throws`() {
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        val activity = controller.get()
        val bridge = MainActivity.Bridge(activity, "example.test")
        bridge.getPermissionStatus()
        bridge.packetStatus("nope")
        bridge.sendPacket("{}")
        controller.destroy()
    }

    @Test
    fun `a dismissed file chooser result does not throw`() {
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        val activity = controller.get()
        // The relay "Receive an alert file" input routes through the WebView file chooser; a
        // cancelled picker must be answered harmlessly rather than leaving the input stuck.
        activity.onActivityResult(9003, android.app.Activity.RESULT_CANCELED, null)
        controller.destroy()
    }

    @Test
    fun `saving the relay export returns a parseable result`() {
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        val activity = controller.get()
        // "Save alert file to transfer" writes natively inside the WebView; the PWA parses the
        // returned JSON, so it must always be well formed.
        val result = org.json.JSONObject(activity.saveTextToDownloads("reach-alert-2026-01-01.json", "{\"packets\":[]}"))
        org.junit.Assert.assertTrue(result.has("saved"))
        controller.destroy()
    }
}
