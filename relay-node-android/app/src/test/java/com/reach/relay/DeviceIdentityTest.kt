package com.reach.relay

import android.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

/**
 * The relay identity is created through the AndroidKeyStore provider. That provider only accepts a
 * KeyGenParameterSpec; passing a bare ECGenParameterSpec makes initialize() throw and took the whole
 * relay service down at startup. These assertions run the real identity code path and prove the
 * resulting key is a P-256 key that can actually sign.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class DeviceIdentityTest {

    @Test
    fun `identity is created and exposes a public key`() {
        val publicKey = DeviceIdentity.publicKeyB64()
        assertTrue("public key must be present", publicKey.isNotBlank())
        val der = Base64.decode(publicKey, Base64.DEFAULT)
        assertTrue("public key must decode to DER", der.isNotEmpty())
    }

    @Test
    fun `identity signs with SHA256withECDSA and verifies`() {
        val publicKey = DeviceIdentity.publicKeyB64()
        val signature = DeviceIdentity.sign("reach-relay-test")
        assertTrue(signature.isNotBlank())
        val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.decode(publicKey, Base64.DEFAULT)))
        val verifier = Signature.getInstance("SHA256withECDSA")
        verifier.initVerify(key)
        verifier.update("reach-relay-test".toByteArray(Charsets.UTF_8))
        assertTrue("signature must verify against the advertised key", verifier.verify(Base64.decode(signature, Base64.DEFAULT)))
    }

    @Test
    fun `identity is stable across calls`() {
        assertEquals(DeviceIdentity.publicKeyB64(), DeviceIdentity.publicKeyB64())
        assertEquals(DeviceIdentity.deviceId(), DeviceIdentity.deviceId())
    }
}
