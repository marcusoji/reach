package com.reach.relay

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.wifi.p2p.WifiP2pConfig
import android.net.wifi.p2p.WifiP2pDevice
import android.net.wifi.p2p.WifiP2pManager
import android.os.Handler
import android.os.Looper
import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors
import kotlin.concurrent.thread

/**
 * Wi-Fi Direct framed transfer with application-level ACK.
 * Frame: [4-byte length][payload]
 * After send, wait for ACK frame; only then report success.
 */
@SuppressLint("MissingPermission") // sendWithAck() gates on Permissions.wifiDirect() and fails closed
class WifiDirectRelay(private val context: Context) {
    private val manager = context.getSystemService(Context.WIFI_P2P_SERVICE) as? WifiP2pManager
    private val channel = manager?.initialize(context, context.mainLooper, null)
    private val executor = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    private var server: ServerSocket? = null

    fun send(packet: ByteArray, onComplete: (Boolean) -> Unit = {}) {
        sendWithAck(packet, "", "") { ok, _ -> onComplete(ok) }
    }

    fun sendWithAck(
        packet: ByteArray,
        packetId: String,
        packetHash: String,
        onComplete: (Boolean, String?) -> Unit
    ) {
        if (manager == null || channel == null) {
            onComplete(false, null); return
        }
        if (!Permissions.wifiDirect(context)) {
            onComplete(false, null); return
        }
        if (packet.size > RelayProtocol.MAX_PACKET_BYTES) {
            onComplete(false, null); return
        }
        val peers = mutableListOf<WifiP2pDevice>()
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context?, intent: Intent?) {
                if (intent?.action == WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION) {
                    manager.requestPeers(channel) { list ->
                        peers.clear()
                        peers.addAll(list.deviceList)
                    }
                }
            }
        }
        try {
            context.registerReceiver(receiver, IntentFilter(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION))
        } catch (_: Exception) {}
        manager.discoverPeers(channel, object : WifiP2pManager.ActionListener {
            override fun onSuccess() {}
            override fun onFailure(reason: Int) {
                safeUnregister(receiver)
                onComplete(false, null)
            }
        })
        handler.postDelayed({
            safeUnregister(receiver)
            val peer = peers.firstOrNull()
            if (peer == null) {
                onComplete(false, null); return@postDelayed
            }
            val config = WifiP2pConfig().apply { deviceAddress = peer.deviceAddress }
            manager.connect(channel, config, object : WifiP2pManager.ActionListener {
                override fun onSuccess() {
                    manager.requestConnectionInfo(channel) { info ->
                        if (info == null || !info.groupFormed) {
                            onComplete(false, peer.deviceAddress); return@requestConnectionInfo
                        }
                        executor.execute {
                            var ok = false
                            try {
                                val host = if (info.isGroupOwner) "127.0.0.1" else info.groupOwnerAddress.hostAddress
                                Socket().use { socket ->
                                    socket.soTimeout = RelayProtocol.ACK_TIMEOUT_MS.toInt()
                                    socket.connect(InetSocketAddress(host, 8988), 8_000)
                                    val out = DataOutputStream(socket.getOutputStream())
                                    out.writeInt(packet.size)
                                    out.write(packet)
                                    out.flush()
                                    val inp = DataInputStream(socket.getInputStream())
                                    val ackLen = inp.readInt()
                                    require(ackLen in 16..4096)
                                    val ackBytes = ByteArray(ackLen)
                                    inp.readFully(ackBytes)
                                    val ack = RelayProtocol.parseAck(ackBytes)
                                    ok = if (packetId.isNotBlank() && packetHash.isNotBlank()) {
                                        RelayProtocol.verifyAck(ack, packetId, packetHash)
                                    } else ack.optBoolean("accepted", false)
                                }
                            } catch (_: Exception) {
                                ok = false
                            }
                            handler.post { onComplete(ok, peer.deviceAddress) }
                        }
                    }
                }
                override fun onFailure(reason: Int) {
                    onComplete(false, peer.deviceAddress)
                }
            })
        }, 4_000)
    }

    /** Start group-owner style listener that validates, enqueues, returns ACK. */
    fun startAckServer(context: Context, onPacket: (org.json.JSONObject) -> Unit) {
        thread(isDaemon = true, name = "reach-wifi-ack") {
            try {
                server = ServerSocket(8988).also { it.soTimeout = 0 }
                while (!Thread.currentThread().isInterrupted) {
                    try {
                        server?.accept()?.use { socket ->
                            socket.soTimeout = RelayProtocol.ACK_TIMEOUT_MS.toInt()
                            val inp = DataInputStream(socket.getInputStream())
                            val len = inp.readInt()
                            require(len in 32..RelayProtocol.MAX_PACKET_BYTES)
                            val raw = ByteArray(len)
                            inp.readFully(raw)
                            var accepted = false
                            var id = ""
                            var hash = ""
                            var reason = ""
                            try {
                                val packet = RelayProtocol.validate(raw)
                                id = packet.optString("k")
                                hash = packet.optString("x")
                                onPacket(packet)
                                accepted = true
                            } catch (e: Exception) {
                                reason = e.message ?: "reject"
                            }
                            val ack = RelayProtocol.buildAck(id.ifBlank { "unknown" }, hash.ifBlank { "0".repeat(64) }, accepted, reason)
                            val out = DataOutputStream(socket.getOutputStream())
                            out.writeInt(ack.size)
                            out.write(ack)
                            out.flush()
                        }
                    } catch (_: Exception) {}
                }
            } catch (_: Exception) {}
        }
    }

    fun close() {
        try { server?.close() } catch (_: Exception) {}
        server = null
    }

    private fun safeUnregister(receiver: BroadcastReceiver) {
        try { context.unregisterReceiver(receiver) } catch (_: Exception) {}
    }
}
