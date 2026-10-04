package com.reach.relay

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The routing rule that decides "gateway or radio hop". This is the fix for "no network, send, and
 * nothing goes": a node with a configured gateway but no connectivity must offer the packet to the
 * radio, not spin on an upload that cannot happen.
 */
class RelayRoutingTest {

    @Test
    fun `gateway is used only when it is configured and reachable`() {
        assertTrue(RelayRouting.gatewayRouteAvailable(gatewayConfigured = true, hasConnectivity = true))
    }

    @Test
    fun `a configured gateway with no connectivity falls back to the radio`() {
        assertFalse(RelayRouting.gatewayRouteAvailable(gatewayConfigured = true, hasConnectivity = false))
    }

    @Test
    fun `no gateway always uses the radio`() {
        assertFalse(RelayRouting.gatewayRouteAvailable(gatewayConfigured = false, hasConnectivity = true))
        assertFalse(RelayRouting.gatewayRouteAvailable(gatewayConfigured = false, hasConnectivity = false))
    }
}
