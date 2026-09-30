package com.reach.relay

import android.Manifest
import android.content.*
import android.content.pm.PackageManager
import android.net.Network
import android.net.wifi.p2p.*
import android.os.Build
import android.os.Looper
import androidx.core.content.ContextCompat
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors

/** Real Android Wi-Fi Direct transport. Discovery, connection, group-owner negotiation and bounded TCP transfer. */
class WifiDirectRelay(private val context: Context) {
    companion object { const val PORT = 38471; const val SERVICE_NAME = "_reach-relay._tcp" }
    private val manager=context.getSystemService(Context.WIFI_P2P_SERVICE) as WifiP2pManager
    private val channel=manager.initialize(context, Looper.getMainLooper(), null)
    private val executor=Executors.newCachedThreadPool()
    private var server:ServerSocket?=null
    private var network:Network?=null
    private var receiver:BroadcastReceiver?=null
    private var peers:List<WifiP2pDevice> = emptyList()
    private var onReady:(String?)->Unit={}

    fun start(onPeers:(List<WifiP2pDevice>)->Unit, onPacket:(ByteArray)->Unit, onReady:(String?)->Unit={}) {
        this.onReady=onReady
        require(permissionGranted()) { "Wi-Fi Direct permission is not granted" }
        receiver = object: BroadcastReceiver(){
            override fun onReceive(c:Context?, intent:Intent?) {
                when(intent?.action){
                    WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION -> manager.requestPeers(channel){ peers=it.deviceList.toList(); onPeers(peers) }
                    WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION -> requestConnection(onPacket)
                }
            }
        }
        val filter=IntentFilter().apply{
            addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION)
            addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION)
            addAction(WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION)
        }
        context.registerReceiver(receiver,filter)
        discover(onPeers)
    }

    fun discover(onPeers:(List<WifiP2pDevice>)->Unit){
        if(!permissionGranted()) return
        manager.discoverPeers(channel, object:WifiP2pManager.ActionListener{ override fun onSuccess(){}; override fun onFailure(_:Int){} })
        manager.requestPeers(channel){ peers=it.deviceList.toList(); onPeers(peers) }
    }

    fun connect(device:WifiP2pDevice, onResult:(Boolean)->Unit = {}) {
        if(!permissionGranted()) { onResult(false); return }
        val config=WifiP2pConfig().apply{ deviceAddress=device.deviceAddress; wps.setup=android.net.wifi.WpsInfo.PBC }
        manager.connect(channel,config,object:WifiP2pManager.ActionListener{ override fun onSuccess(){onResult(true)}; override fun onFailure(_:Int){onResult(false)} })
    }

    private fun requestConnection(onPacket:(ByteArray)->Unit){
        if(!permissionGranted()) return
        manager.requestConnectionInfo(channel){ info ->
            if(!info.groupFormed) return@requestConnectionInfo
            if(info.isGroupOwner) { startLocalServer(onPacket); onReady(null) }
            else if(info.groupOwnerAddress != null) { network = null; onReady(info.groupOwnerAddress.hostAddress) }
        }
    }

    fun startLocalServer(onPacket:(ByteArray)->Unit){
        if(server?.isClosed == false) return
        executor.execute{
            try{
                server=ServerSocket(PORT)
                while(server?.isClosed == false){
                    server!!.accept().use { socket ->
                        socket.soTimeout=5000
                        val input=BufferedInputStream(socket.getInputStream())
                        val header=ByteArray(4); if(input.readFully(header)!=4) return@use
                        val n=((header[0].toInt() and 255) shl 24) or ((header[1].toInt() and 255) shl 16) or ((header[2].toInt() and 255) shl 8) or (header[3].toInt() and 255)
                        if(n !in 1..RelayProtocol.MAX_BYTES) return@use
                        val body=ByteArray(n); if(input.readFully(body)!=n) return@use
                        onPacket(body)
                    }
                }
            }catch(_:Exception){}
        }
    }

    fun send(host:String, packet:ByteArray, timeoutMs:Int=5000, onComplete:(Boolean)->Unit={} ){
        require(packet.size in 1..RelayProtocol.MAX_BYTES)
        executor.execute{ try{
            Socket().use { socket ->
                socket.connect(InetSocketAddress(host,PORT),timeoutMs); socket.soTimeout=timeoutMs
                val out=BufferedOutputStream(socket.getOutputStream()); val n=packet.size
                out.write(byteArrayOf((n ushr 24).toByte(),(n ushr 16).toByte(),(n ushr 8).toByte(),n.toByte())); out.write(packet); out.flush(); onComplete(true)
            }
        }catch(_:Exception){ onComplete(false) } }
    }

    private fun permissionGranted():Boolean = if(Build.VERSION.SDK_INT>=33) ContextCompat.checkSelfPermission(context,Manifest.permission.NEARBY_WIFI_DEVICES)==PackageManager.PERMISSION_GRANTED else ContextCompat.checkSelfPermission(context,Manifest.permission.ACCESS_FINE_LOCATION)==PackageManager.PERMISSION_GRANTED

    fun close(){ try{receiver?.let{context.unregisterReceiver(it)}}catch(_:Exception){}; try{server?.close()}catch(_:Exception){} }

    private fun java.io.InputStream.readFully(buf:ByteArray):Int { var off=0; while(off<buf.size){ val r=read(buf,off,buf.size-off); if(r<0)return off; off+=r }; return off }
}
