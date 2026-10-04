package com.reach.relay

/**
 * The relay routing rule, kept free of Android imports so it is directly unit testable.
 *
 * A packet takes the gateway only when a gateway is configured *and* there is connectivity. A node
 * with a configured gateway but no internet must offer the packet to the radio instead of retrying
 * an upload that cannot happen — that is the "no network, send, and nothing goes" bug.
 */
object RelayRouting {
    fun gatewayRouteAvailable(gatewayConfigured: Boolean, hasConnectivity: Boolean): Boolean =
        gatewayConfigured && hasConnectivity
}
