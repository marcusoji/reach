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
}
