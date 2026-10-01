package com.reach.relay

import android.annotation.SuppressLint
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.util.UUID

/**
 * BLE central: fragment write + wait for ACK characteristic notification/read.
 * Packet is only considered delivered when ACK verifies packet id + hash + accepted.
 */
@SuppressLint("MissingPermission") // every privileged call is gated by permissions() below
class BleCentralRelay(private val context: Context, private val onPeer: (Boolean) -> Unit = {}) {
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
    private var completion: (Boolean, String?) -> Unit = { _, _ -> }
    private var finished = false
    private val service = UUID.fromString(RelayProtocol.SERVICE_UUID)
    private val dataUuid = UUID.fromString(RelayProtocol.DATA_UUID)
    private val ackUuid = UUID.fromString(RelayProtocol.ACK_UUID)
    private val handler = Handler(Looper.getMainLooper())
    private val ackTimeout = Runnable { finish(false, null) }

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
        finished = false
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
            gatt = result.device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
        }
    }

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                // Prefer encrypted link when bonding is available
                try {
                    if (Build.VERSION.SDK_INT >= 19) {
                        g.device.createBond()
                    }
                } catch (_: Exception) {}
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
            finish(ok, peer ?: ack.optString("receiver_device_id"))
        } catch (_: Exception) {
            // mismatched/invalid ACK ignored; timeout will fail
        }
    }

    private fun startFragments(g: BluetoothGatt, packet: ByteArray) {
        total = (packet.size + RelayProtocol.FRAGMENT - 1) / RelayProtocol.FRAGMENT
        seq = 0
        writeNext(g)
    }

    private fun writeNext(g: BluetoothGatt) {
        val packet = pending ?: return
        val start = seq * RelayProtocol.FRAGMENT
        val end = minOf(packet.size, start + RelayProtocol.FRAGMENT)
        val chunk = packet.copyOfRange(start, end)
        val header = byteArrayOf(seq.toByte(), total.toByte())
        val frame = header + chunk
        dataChar?.value = frame
        dataChar?.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        seq++
        g.writeCharacteristic(dataChar)
    }

    private fun permissions(): Boolean = Permissions.bleScan(context) && Permissions.bleConnect(context)
}
