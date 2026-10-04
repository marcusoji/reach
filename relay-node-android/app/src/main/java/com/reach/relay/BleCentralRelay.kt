package com.reach.relay

import android.annotation.SuppressLint
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.Context
import android.os.Handler
import android.os.Looper
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

/**
 * BLE central: fragment write + wait for ACK characteristic notification/read.
 * Packet is only considered delivered when ACK verifies packet id + hash + accepted.
 */
@SuppressLint("MissingPermission") // every privileged call is gated by permissions() below
class BleCentralRelay(
    private val context: Context,
    private val onPeer: (Boolean) -> Unit = {},
) {
    private val adapter = (context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
    private var scanner: BluetoothLeScanner? = null
    private var gatt: BluetoothGatt? = null
    private var dataChar: BluetoothGattCharacteristic? = null
    private var ackChar: BluetoothGattCharacteristic? = null
    private var pending: ByteArray? = null
    private var packetId: String = ""
    private var packetHash: String = ""
    private var seq = 0
    private var total = 0
    // Random per-transfer id so a receiver can tell concurrent transfers apart; the frame layout
    // is [transferId:4][seq:1][total:1][payload...], shared with BleTransfer.
    private var transferId = ByteArray(4)
    // ATT payload ceiling for the link. 23 is the BLE default MTU, so 20 bytes is the largest
    // value a characteristic write may carry until the peer grants a larger MTU. Writing more
    // than this fails the ATT write, so fragments must be sized from the negotiated MTU.
    private var fragmentBytes = 20
    // Chunk size is captured when a transfer starts: the MTU callback arrives asynchronously, and
    // changing the chunk size midway would make `total` disagree with the fragments actually sent.
    private var chunkSize = 20
    private var started = false
    private var completion: (Boolean, String?) -> Unit = { _, _ -> }
    private var finished = false
    private val service = UUID.fromString(RelayProtocol.SERVICE_UUID)
    private val dataUuid = UUID.fromString(RelayProtocol.DATA_UUID)
    private val ackUuid = UUID.fromString(RelayProtocol.ACK_UUID)
    private val handler = Handler(Looper.getMainLooper())
    private val ackTimeout = Runnable { finish(false, null) }
    // The beacon the scanned peer advertised; verified against its signed relay identity before a
    // transfer is counted as delivered.
    private var peerBeacon: String? = null

    /**
     * The configured instance is owned by a single scan callback, so it must not be re-entered.
     * [finish] marks the transfer done and a second call is ignored, which would silently drop the
     * second packet — so a caller holding this instance serialises instead of overlapping.
     */
    private val busy = AtomicBoolean(false)

    fun discoverAndSend(packet: ByteArray, onComplete: (Boolean) -> Unit = {}) {
        discoverAndSendWithAck(packet, "", "") { ok, _ -> onComplete(ok) }
    }

    fun discoverAndSendWithAck(
        packet: ByteArray,
        id: String,
        hash: String,
        onComplete: (Boolean, String?) -> Unit
    ) {
        if (!permissions() || adapter == null || !adapter.isEnabled) {
            onComplete(false, null); return
        }
        // Fail fast rather than let a second transfer be swallowed by the in-flight one.
        if (!busy.compareAndSet(false, true)) {
            onComplete(false, null); return
        }
        finished = false
        started = false
        fragmentBytes = 20
        java.security.SecureRandom().nextBytes(transferId)
        pending = packet
        packetId = id
        packetHash = hash
        completion = onComplete
        scanner = adapter.bluetoothLeScanner
        scanner?.startScan(
            listOf(ScanFilter.Builder().setServiceUuid(android.os.ParcelUuid(service)).build()),
            ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(),
            scanCallback
        )
        handler.postDelayed({
            scanner?.stopScan(scanCallback)
            if (!finished && pending != null) finish(false, null)
        }, 8_000)
    }

    private fun finish(ok: Boolean, peer: String?) {
        if (finished) return
        finished = true
        busy.set(false)
        handler.removeCallbacks(ackTimeout)
        try { scanner?.stopScan(scanCallback) } catch (_: Exception) {}
        try { gatt?.close() } catch (_: Exception) {}
        gatt = null
        pending = null
        val cb = completion
        completion = { _, _ -> }
        cb(ok, peer)
        onPeer(ok)
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(type: Int, result: ScanResult) {
            scanner?.stopScan(this)
            // Remember the peer's pairing beacon so the ACK can be attributed to a node that
            // advertised the same relay configuration we did, not merely the same service UUID.
            // Absent (older build, or a scanner that hides manufacturer data) means "unknown",
            // which is treated as compatible so mixed versions still interoperate.
            peerBeacon = RelayProtocol.parsePairingBeacon(result.scanRecord?.getManufacturerSpecificData(RelayProtocol.PAIRING_COMPANY_ID))
            gatt = result.device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
        }
    }

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                // No createBond() here. Bonding a stranger mid-emergency pops a system pairing dialog
                // (and, unattended, simply stalls the transfer) while the characteristic permissions
                // require an *encrypted MITM* link that a first, unbonded connection does not have.
                // The packet's own ECDSA signature is the trust anchor, so the relay proceeds over a
                // plain link and no bond is forced.
                g.discoverServices()
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                finish(false, null)
            }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                finish(false, null); return
            }
            val svc = g.getService(service) ?: run { finish(false, null); return }
            dataChar = svc.getCharacteristic(dataUuid)
            ackChar = svc.getCharacteristic(ackUuid)
            if (dataChar == null) {
                finish(false, null); return
            }
            // Ask for a larger ATT MTU so a packet needs fewer fragments. If the peer refuses we
            // keep the 20-byte default and stay correct, just slower.
            try { g.requestMtu(RelayProtocol.REQUESTED_MTU) } catch (_: Exception) { }
            // Subscribe to ACK notifications when available
            ackChar?.let { ch ->
                g.setCharacteristicNotification(ch, true)
                ch.descriptors?.firstOrNull()?.let { d ->
                    d.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    g.writeDescriptor(d)
                }
            }
            pending?.let { startFragments(g, it) }
        }

        override fun onCharacteristicWrite(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                finish(false, g.device?.address); return
            }
            if (seq < total) writeNext(g)
            else {
                // All fragments written — wait for ACK, do NOT treat as success yet
                handler.postDelayed(ackTimeout, RelayProtocol.ACK_TIMEOUT_MS)
                // Also try explicit ACK read if notifications unsupported
                ackChar?.let { g.readCharacteristic(it) }
            }
        }

        override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
            // ATT payload is MTU minus the 3-byte ATT header; only accept a usable increase.
            if (status == BluetoothGatt.GATT_SUCCESS && mtu - 3 > fragmentBytes) {
                fragmentBytes = minOf(mtu - 3, RelayProtocol.MAX_FRAGMENT)
            }
        }

        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            if (characteristic.uuid == ackUuid) handleAck(characteristic.value, g.device?.address)
        }

        override fun onCharacteristicRead(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS && characteristic.uuid == ackUuid) {
                handleAck(characteristic.value, g.device?.address)
            }
        }
    }

    private fun handleAck(raw: ByteArray?, peer: String?) {
        if (raw == null) return
        try {
            val ack = RelayProtocol.parseAck(raw)
            val ok = if (packetId.isNotBlank() && packetHash.isNotBlank()) {
                RelayProtocol.verifyAck(ack, packetId, packetHash)
            } else {
                ack.optBoolean("accepted", false)
            }
            // Only accept the ACK from a node that advertised the same relay configuration. Without
            // this the transfer would count as delivered against any device that happened to answer
            // on the REACH service UUID, including a different build. A peer that advertised no
            // beacon (older build) is treated as compatible rather than silently dropped.
            if (ok && peerBeacon != null && !RelayProtocol.verifyPairingSignature(peerBeacon, ack.optString("receiver_device_id"))) {
                return // timeout will fail the transfer honestly
            }
            finish(ok, peer ?: ack.optString("receiver_device_id"))
        } catch (_: Exception) {
            // mismatched/invalid ACK ignored; timeout will fail
        }
    }

    private fun startFragments(g: BluetoothGatt, packet: ByteArray) {
        if (started) return
        started = true
        chunkSize = fragmentBytes
        total = (packet.size + chunkSize - 1) / chunkSize
        // seq/total are single bytes in the frame header; more than 255 fragments cannot be framed.
        if (total > BleTransfer.MAX_TOTAL) { finish(false, null); return }
        seq = 0
        writeNext(g)
    }

    private fun writeNext(g: BluetoothGatt) {
        val packet = pending ?: return
        val start = seq * chunkSize
        val end = minOf(packet.size, start + chunkSize)
        val chunk = packet.copyOfRange(start, end)
        val frame = BleTransfer.frame(transferId, seq, total, chunk)
        dataChar?.value = frame
        dataChar?.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        seq++
        g.writeCharacteristic(dataChar)
    }

    private fun permissions(): Boolean = Permissions.bleScan(context) && Permissions.bleConnect(context)
}
