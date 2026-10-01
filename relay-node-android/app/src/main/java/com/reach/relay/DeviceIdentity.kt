package com.reach.relay

import android.util.Base64
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/** Hardware-backed (when supported) device identity. Private key never leaves Android Keystore. */
object DeviceIdentity {
    private const val ALIAS = "reach-relay-signing-v2"
    private const val STORE = "AndroidKeyStore"

    fun keyPair(): KeyPair {
        val ks = KeyStore.getInstance(STORE).apply { load(null) }
        val existing = ks.getEntry(ALIAS, null) as? KeyStore.PrivateKeyEntry
        if (existing != null) return KeyPair(existing.certificate.publicKey, existing.privateKey)
        val generator = KeyPairGenerator.getInstance("EC", STORE)
        generator.initialize(ECGenParameterSpec("secp256r1"))
        return generator.generateKeyPair()
    }

    fun deviceId(): String = publicKeyB64().take(24)
    fun publicKeyB64(): String = Base64.encodeToString(keyPair().public.encoded, Base64.NO_WRAP)

    fun sign(text:String):String {
        val s=Signature.getInstance("SHA256withECDSA"); s.initSign(keyPair().private); s.update(text.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(s.sign(),Base64.NO_WRAP)
    }

    // The signed payload omits x: x is defined as sha256 of this string, so including x
    // would make the hash self-referential. The fingerprint still binds every other field,
    // and the ECDSA signature over this string binds x.
    fun canonicalSource(packet:org.json.JSONObject):String = listOf(
        "v","k","e","m","incident_id","source_device_id","minimal_payload"
    ).joinToString("&") { key -> "$key=${packet.opt(key)}" }

    fun canonicalRelay(packet:org.json.JSONObject):String = listOf(
        "v","k","e","h","m","incident_id","source_device_id","x","relay_device_id","minimal_payload"
    ).joinToString("&") { key -> "$key=${packet.opt(key)}" }

    fun signSourcePacket(packet:org.json.JSONObject):org.json.JSONObject {
        packet.put("source_device_id",deviceId()); packet.put("source_public_key",publicKeyB64())
        packet.put("source_signed_payload",canonicalSource(packet)); packet.put("source_signature",sign(packet.getString("source_signed_payload")))
        return packet
    }

    fun signRelayPacket(packet:org.json.JSONObject):org.json.JSONObject {
        packet.put("relay_device_id",deviceId()); packet.put("relay_public_key",publicKeyB64())
        packet.put("relay_signed_payload",canonicalRelay(packet)); packet.put("relay_signature",sign(packet.getString("relay_signed_payload")))
        return packet
    }
}
