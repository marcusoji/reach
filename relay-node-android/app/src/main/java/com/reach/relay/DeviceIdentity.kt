package com.reach.relay

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/** Hardware-backed (when supported) device identity. Private key never leaves Android Keystore. */
object DeviceIdentity {
    private const val ALIAS = "reach-relay-signing-v2"
    private const val STORE = "AndroidKeyStore"
    private const val TAG = "ReachRelay"
    @Volatile private var cached: KeyPair? = null

    /**
     * The relay signing identity, created once per process.
     *
     * The AndroidKeyStore provider only accepts a [KeyGenParameterSpec] — passing a bare
     * [ECGenParameterSpec] makes `initialize` throw `InvalidAlgorithmParameterException`, which
     * took the whole relay service down the moment it tried to advertise. A few OS builds also
     * refuse EC keys in the keystore outright, so if the hardware-backed path is unavailable the
     * identity degrades to an in-memory P-256 key instead of crashing the node.
     */
    fun keyPair(): KeyPair {
        cached?.let { return it }
        synchronized(this) {
            cached?.let { return it }
            val kp = loadOrCreate()
            cached = kp
            return kp
        }
    }

    private fun loadOrCreate(): KeyPair {
        try {
            val ks = KeyStore.getInstance(STORE).apply { load(null) }
            (ks.getEntry(ALIAS, null) as? KeyStore.PrivateKeyEntry)?.let {
                return KeyPair(it.certificate.publicKey, it.privateKey)
            }
            val generator = KeyPairGenerator.getInstance("EC", STORE)
            generator.initialize(
                KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                    .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .build()
            )
            return generator.generateKeyPair()
        } catch (e: Exception) {
            Log.w(TAG, "AndroidKeyStore identity unavailable, using a software key: ${e.message}")
        }
        val generator = KeyPairGenerator.getInstance("EC")
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
    //
    // Values are encoded with canonicalValue, not org.json's own serialisation: the shared
    // format is `key=${JS value}`, where a scalar is String(v) (a raw string, unquoted) and a
    // container is JSON.stringify(v). org.json escapes "/" as "\/" (and, on older AOSP, C1
    // controls as \uXXXX) while JSON.stringify emits a bare "/", so nested payloads — and any
    // base64 device id/key/signature or URL containing "/" — produced a different canonical
    // string and failed every cross-language signature/fingerprint check.
    fun canonicalSource(packet:org.json.JSONObject):String = listOf(
        "v","k","e","m","incident_id","source_device_id","minimal_payload"
    ).joinToString("&") { key -> "$key=${canonicalValue(packet.opt(key))}" }

    fun canonicalRelay(packet:org.json.JSONObject):String = listOf(
        "v","k","e","h","m","incident_id","source_device_id","x","relay_device_id","minimal_payload"
    ).joinToString("&") { key -> "$key=${canonicalValue(packet.opt(key))}" }

    /** Matches the JS `cv` helper: containers are JSON.stringify'd, scalars are String(v). */
    internal fun canonicalValue(v:Any?):String = when(v){
        is org.json.JSONObject -> jsJson(v)
        is org.json.JSONArray -> jsJson(v)
        null -> "null"
        else -> v.toString()
    }

    /** Encode a JSON value exactly as V8's JSON.stringify does. */
    internal fun jsJson(v:Any?):String = when(v){
        null, org.json.JSONObject.NULL -> "null"
        is org.json.JSONObject -> v.keys().asSequence().joinToString(",","{","}"){ k -> "${jsString(k)}:${jsJson(v.opt(k))}" }
        is org.json.JSONArray -> (0 until v.length()).joinToString(",","[","]"){ i -> jsJson(v.opt(i)) }
        is String -> jsString(v)
        is Boolean -> v.toString()
        is Double -> if(v.isFinite()&&v==Math.floor(v)&&Math.abs(v)<1e15)v.toLong().toString() else v.toString()
        is Number -> v.toString()
        else -> jsString(v.toString())
    }

    /** JSON string escaping as V8 does it: no "/" escaping, raw non-ASCII, \uXXXX for <0x20. */
    private fun jsString(s:String):String{
        val sb=StringBuilder(s.length+2); sb.append('"')
        for(ch in s) when{
            ch=='"' -> sb.append("\\\"")
            ch=='\\' -> sb.append("\\\\")
            ch=='\b' -> sb.append("\\b")
            ch=='\u000C' -> sb.append("\\f")
            ch=='\n' -> sb.append("\\n")
            ch=='\r' -> sb.append("\\r")
            ch=='\t' -> sb.append("\\t")
            ch<' ' -> sb.append("\\u%04x".format(ch.code))
            else -> sb.append(ch)
        }
        sb.append('"'); return sb.toString()
    }

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
