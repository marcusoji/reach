package com.reach.relay

import org.json.JSONObject
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import android.util.Base64

object RelayProtocol {
    const val SERVICE_UUID = "5f7a0001-8b3a-4e54-9f1e-726561636831"
    const val CONTROL_UUID = "5f7a0002-8b3a-4e54-9f1e-726561636832"
    const val DATA_UUID = "5f7a0003-8b3a-4e54-9f1e-726561636833"
    const val ACK_UUID = "5f7a0004-8b3a-4e54-9f1e-726561636834"
    const val MAX_HOPS = 6
    const val MAX_BYTES = 4096
    const val CHUNK_BYTES = 180
    const val TTL_MS = 30 * 60 * 1000L

    fun validate(raw: ByteArray): JSONObject {
        require(raw.size in 1..MAX_BYTES) { "Invalid packet size" }
        val o=JSONObject(String(raw,Charsets.UTF_8))
        require(o.optInt("v") == 2) { "Unsupported packet version" }
        require(o.optString("k").length in 8..160) { "Missing packet key" }
        require(o.optString("x").length in 64..64) { "Missing packet hash" }
        require(System.currentTimeMillis() <= o.optLong("e")) { "Packet expired" }
        val max=o.optInt("m",MAX_HOPS); val hops=o.optInt("h",0)
        require(max in 1..MAX_HOPS && hops in 0 until max) { "Hop limit reached" }
        verify(o,o.optString("source_public_key"),o.optString("source_signature"),o.optString("source_signed_payload"))
        if(o.optString("relay_device_id").isNotBlank()) verify(o,o.optString("relay_public_key"),o.optString("relay_signature"),o.optString("relay_signed_payload"),relay=true)
        val expected=sha256(DeviceIdentity.canonicalSource(o))
        require(expected == o.optString("x")) { "Packet fingerprint mismatch" }
        return o
    }

    private fun verify(o:JSONObject,keyB64:String,sigB64:String,signed:String,relay:Boolean=false){
        require(keyB64.isNotBlank() && sigB64.isNotBlank() && signed.isNotBlank()) { "Missing packet signature" }
        val key=KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.decode(keyB64,Base64.DEFAULT)))
        val s=Signature.getInstance("SHA256withECDSA"); s.initVerify(key); s.update(signed.toByteArray(Charsets.UTF_8))
        require(s.verify(Base64.decode(sigB64,Base64.DEFAULT))) { if(relay) "Invalid relay signature" else "Invalid source signature" }
    }

    fun newPacket(payload:JSONObject):JSONObject{
        val p=JSONObject(payload.toString()); val now=System.currentTimeMillis()
        p.put("v",2); p.put("k",p.optString("k").ifBlank{java.util.UUID.randomUUID().toString()}); p.put("e",now+TTL_MS); p.put("h",0); p.put("m",MAX_HOPS); p.put("source_device_id",DeviceIdentity.deviceId()); p.put("source_public_key",DeviceIdentity.publicKeyB64())
        p.put("x",sha256(DeviceIdentity.canonicalSource(p))); return DeviceIdentity.signSourcePacket(p)
    }

    fun nextHop(o:JSONObject):JSONObject{
        val p=JSONObject(o.toString()); p.put("h",p.optInt("h")+1); p.remove("relay_signature"); p.remove("relay_signed_payload"); p.remove("relay_device_id"); p.remove("relay_public_key"); return DeviceIdentity.signRelayPacket(p)
    }

    private fun sha256(s:String):String=MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString(""){"%02x".format(it)}
}
