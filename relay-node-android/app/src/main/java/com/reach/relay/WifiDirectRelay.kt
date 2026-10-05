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

    /** True while the ACK listener is bound, so the node can report the Wi-Fi half honestly. */
    @Volatile var listening = false
        private set

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
            // groupOwnerIntent = 0 asks to be the *client*, so the peer becomes the group owner.
            // That is what makes the transfer work: the ACK server binds on the receiver, and a
            // client reaches the owner's address — if this node became the owner instead, its own
            // 127.0.0.1 address would be dialled and the ACK server would never be reached.
            val config = WifiP2pConfig().apply {
                deviceAddress = peer.deviceAddress
                groupOwnerIntent = 0
            }
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
                    // A node that had formed its own autonomous group cannot join another. Drop the
                    // group so the next attempt (or the peer's) can connect, then report the miss.
                    try { manager.removeGroup(channel, null) } catch (_: Exception) {}
                    onComplete(false, peer.deviceAddress)
                }
            })
        }, 4_000)
    }

    /** Start group-owner style listener that validates, enqueues, returns ACK. */
    fun startAckServer(context: Context, onListening: (Boolean) -> Unit = {}, onPacket: (org.json.JSONObject) -> Unit) {
        // Fail closed: without the Wi-Fi Direct permission the radio is unusable, and binding the
        // listener anyway would advertise a relay path that can never complete a transfer.
        if (manager == null || channel == null || !Permissions.wifiDirect(context)) return
        // Form an autonomous group and become its owner. Without this the node never joins a group,
        // so a peer that connects over Wi-Fi Direct has no owner address to reach and the ACK
        // listener is unreachable — the Wi-Fi half of the relay could never complete a transfer.
        try {
            manager.createGroup(channel, object : WifiP2pManager.ActionListener {
                override fun onSuccess() {}
                override fun onFailure(reason: Int) { /* already in a group, or busy — the listener still binds */ }
            })
        } catch (_: Exception) {}
        thread(isDaemon = true, name = "reach-wifi-ack") {
            try {
                server = ServerSocket(8988).also { it.soTimeout = 0 }
                listening = true
                try { onListening(true) } catch (_: Exception) {}
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
        listening = false
        // Leave the autonomous group so a later node (or this one, restarted) can form its own.
        try { manager?.removeGroup(channel, null) } catch (_: Exception) {}
    }

    private fun safeUnregister(receiver: BroadcastReceiver) {
        try { context.unregisterReceiver(receiver) } catch (_: Exception) {}
    }
}
