package com.reach.relay

import android.content.Context
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/** Durable store-and-forward engine. A packet is only removed after a synchronous gateway success or a peer ACK callback. */
object RelayForwarder {
    private val executor=Executors.newSingleThreadExecutor()
    private val inFlight=ConcurrentHashMap.newKeySet<String>()
    private var ble:BleCentralRelay?=null
    private var wifi:WifiDirectRelay?=null
    private var wifiHost:String?=null
    private var db:RelayQueueDb?=null

    fun init(context:Context){ if(db==null){db=RelayQueueDb(context);ble=BleCentralRelay(context)} }
    fun setSession(context:Context,apiUrl:String,accessToken:String){ init(context); context.getSharedPreferences("reach",Context.MODE_PRIVATE).edit().putString("api_url",apiUrl.trimEnd('/')).putString("access_token",accessToken).apply() }
    fun registerDevice(context:Context){ init(context); executor.execute{val p=context.getSharedPreferences("reach",Context.MODE_PRIVATE);val api=p.getString("api_url",null)?:return@execute;val token=p.getString("access_token",null)?:return@execute;try{post("$api/devices/register",token,JSONObject().apply{put("device_id",DeviceIdentity.deviceId());put("public_key",DeviceIdentity.publicKeyB64());put("platform","android");put("metadata",JSONObject().apply{put("transports","ble,wifi-direct");put("protocol_version",2)})})}catch(_:Exception){}} }

    fun enqueue(context:Context,packet:JSONObject){init(context);db!!.enqueue(packet);process(context)}

    fun process(context:Context){init(context);executor.execute{
        val queue=db!!.due(); if(queue.isEmpty())return@execute
        val prefs=context.getSharedPreferences("reach",Context.MODE_PRIVATE);val api=prefs.getString("api_url",null);val token=prefs.getString("access_token",null)
        for((id,packet) in queue){
            if(!inFlight.add(id)) continue
            if(api!=null&&!token.isNullOrBlank()) {
                try { val p=RelayProtocol.nextHop(packet); post("$api/relay/packets",token,packetToApi(p)); db!!.success(id); inFlight.remove(id); continue }
                catch(_:Exception) { /* gateway unavailable; try local peer transport below */ }
            }
            try {
                val p=RelayProtocol.nextHop(packet)
                val bytes=p.toString().toByteArray()
                var dispatched=false
                if(ble!=null) {
                    dispatched=true
                    ble?.discoverAndSend(bytes){ok ->
                        if(ok) db?.success(id) else sendWifiOrRetry(context,id,bytes)
                        inFlight.remove(id)
                    }
                }
                if(!dispatched && wifiHost!=null && wifi!=null) {
                    dispatched=true
                    wifi?.send(wifiHost!!,bytes){ok -> if(ok) db?.success(id) else db?.retry(id,1); inFlight.remove(id)}
                }
                if(!dispatched) { db!!.retry(id,1); inFlight.remove(id) }
            } catch(_:Exception) { db!!.retry(id,1); inFlight.remove(id) }
        }
    }}

    private fun sendWifiOrRetry(context:Context,id:String,bytes:ByteArray){
        val host=wifiHost
        if(wifi!=null && !host.isNullOrBlank()) wifi?.send(host,bytes){ok -> if(ok) db?.success(id) else db?.retry(id,1)}
        else db?.retry(id,1)
    }

    fun attachWifi(context:Context,relay:WifiDirectRelay){init(context);wifi=relay}
    fun setWifiPeer(host:String?){wifiHost=host}

    private fun packetToApi(p:JSONObject)=JSONObject().apply{
        put("packet_key",p.optString("k"));put("packet_hash",p.optString("x"));put("hop_count",p.optInt("h"));put("max_hops",p.optInt("m"));put("ttl_expires_at",Instant.ofEpochMilli(p.optLong("e")).toString());put("incident_id",p.optString("incident_id"));put("source_device_id",p.optString("source_device_id"));put("source_public_key",p.optString("source_public_key"));put("source_signature",p.optString("source_signature"));put("source_signed_payload",p.optString("source_signed_payload"));put("relay_device_id",p.optString("relay_device_id"));put("relay_public_key",p.optString("relay_public_key"));put("relay_signature",p.optString("relay_signature"));put("relay_signed_payload",p.optString("relay_signed_payload"));put("minimal_payload",p.optJSONObject("minimal_payload")?:JSONObject());put("transport","native-relay")
    }
    private fun post(url:String,token:String,body:JSONObject){val c=URL(url).openConnection() as HttpURLConnection;c.requestMethod="POST";c.connectTimeout=5000;c.readTimeout=5000;c.doOutput=true;c.setRequestProperty("Content-Type","application/json");c.setRequestProperty("Authorization","Bearer $token");c.outputStream.use{it.write(body.toString().toByteArray())};val code=c.responseCode;if(code !in 200..299)error("HTTP $code");c.disconnect()}
}
