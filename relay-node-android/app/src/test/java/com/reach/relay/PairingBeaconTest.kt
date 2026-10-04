package com.reach.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The pairing beacon is what makes "scan for another phone with the same settings" true: two nodes
 * agree only when the beacon a peer advertises matches the signature of the relay identity that peer
 * signed the ACK with. These are pure functions, so no Android Keystore or radio is needed.
 */
class PairingBeaconTest {

    @Test
    fun `beacon is derived from the relay identity`() {
        val a = RelayProtocol.pairingSignatureFor("device-a")
        val b = RelayProtocol.pairingSignatureFor("device-b")
        assertTrue(a != b)
        assertEquals(RelayProtocol.PAIRING_BEACON_BYTES * 2, a.length)
        assertTrue(a.all { it in '0'..'9' || it in 'a'..'f' })
    }

    @Test
    fun `beacon is stable for the same identity`() {
        assertEquals(
            RelayProtocol.pairingSignatureFor("same-device"),
            RelayProtocol.pairingSignatureFor("same-device"),
        )
    }

    @Test
    fun `a peer beacon verifies against the identity that signed with it`() {
        val id = "peer-device-id"
        val beacon = RelayProtocol.pairingSignatureFor(id)
        assertTrue(RelayProtocol.verifyPairingSignature(beacon, id))
    }

    @Test
    fun `a beacon from a different build does not verify`() {
        val beacon = RelayProtocol.pairingSignatureFor("other-build-device")
        assertFalse(RelayProtocol.verifyPairingSignature(beacon, "our-expected-peer"))
    }

    @Test
    fun `missing or blank values never verify`() {
        assertFalse(RelayProtocol.verifyPairingSignature(null, "device"))
        assertFalse(RelayProtocol.verifyPairingSignature("abcd1234", ""))
    }

    @Test
    fun `beacon round-trips through the advertised bytes`() {
        val bytes = RelayProtocol.pairingSignatureFor("round-trip").toByteArray(Charsets.US_ASCII)
        assertEquals(RelayProtocol.PAIRING_BEACON_BYTES * 2, bytes.size)
        assertEquals(RelayProtocol.pairingSignatureFor("round-trip"), RelayProtocol.parsePairingBeacon(bytes))
    }

    @Test
    fun `malformed beacon bytes are ignored rather than trusted`() {
        assertNull(RelayProtocol.parsePairingBeacon(null))
        assertNull(RelayProtocol.parsePairingBeacon(ByteArray(3)))
        assertNull(RelayProtocol.parsePairingBeacon(ByteArray(RelayProtocol.PAIRING_BEACON_BYTES * 2)))
        // Non-hex characters (all zeros is a valid beacon string, so use letters outside a-f).
        assertNull(RelayProtocol.parsePairingBeacon("zzzzzzzz".toByteArray(Charsets.US_ASCII)))
    }
}
