package com.reach.relay

import android.annotation.SuppressLint
import android.app.*
import android.bluetooth.*
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.ParcelUuid
import android.util.Log
import androidx.core.app.NotificationCompat
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Peripheral: advertise REACH relay service, accept BLE fragments, validate, persist, ACK.
 * Also runs Wi-Fi ACK server and periodic queue drain/cleanup.
 */
@SuppressLint("MissingPermission") // startRelay() gates on the BLUETOOTH_* permissions and returns early
class RelayService : Service() {
    private val serviceUuid = UUID.fromString(RelayProtocol.SERVICE_UUID)
    private val writeUuid = UUID.fromString(RelayProtocol.DATA_UUID)
    private val ackUuid = UUID.fromString(RelayProtocol.ACK_UUID)
    private var gattServer: BluetoothGattServer? = null
    private var advertiser: BluetoothLeAdvertiser? = null
    private var dataChar: BluetoothGattCharacteristic? = null
    private var ackChar: BluetoothGattCharacteristic? = null
    private val transfer = BleTransfer()
    private val running = AtomicBoolean(false)
    private val handler = Handler(Looper.getMainLooper())
    private val lastAck = ConcurrentHashMap<String, ByteArray>()
    private var wifiRelay: WifiDirectRelay? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        try {
            startForeground(42, buildNotification())
        } catch (e: Exception) {
            Log.w(TAG, "foreground notification failed: ${e.message}")
        }
        // Each transport is best-effort: a device that lacks BLE advertising, Wi-Fi Direct or the
        // right permission must still run whichever half it does have, not crash the whole node.
        try {
            startRelay()
        } catch (e: Exception) {
            Log.w(TAG, "BLE relay start failed: ${e.message}")
        }
        try {
            wifiRelay = WifiDirectRelay(this).also { wr ->
                wr.startAckServer(this) { packet ->
                    RelayForwarder.enqueue(this, packet)
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Wi-Fi relay start failed: ${e.message}")
        }
        // Periodic purge + drain
        handler.post(object : Runnable {
            override fun run() {
                try {
                    val db = RelayQueueDb(this@RelayService)
                    db.purgeExpired()
                    db.recoverStaleSending()
                } catch (_: Exception) {}
                try {
                    RelayForwarder.kick(this@RelayService)
                } catch (_: Exception) {}
                handler.postDelayed(this, 30_000L)
            }
        })
    }

    private fun buildNotification(): Notification {
        val channelId = "reach_relay"
        if (Build.VERSION.SDK_INT >= 26) {
            val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(
                NotificationChannel(channelId, "REACH Relay", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val transport = when {
            RelayGatewayUploader.isConfigured(this) -> "Uplink + nearby relay"
            Permissions.wifiDirect(this) -> "Bluetooth + Wi-Fi relay"
            else -> "Bluetooth relay"
        }
        return NotificationCompat.Builder(this, channelId)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentTitle("REACH relay active")
            .setContentText("$transport · listening for nearby emergency packets")
            .setOngoing(true)
            .build()
    }

    private fun startRelay() {
        // Peripheral needs connect (GATT server) + advertise; fail closed rather than
        // letting the platform throw SecurityException on a revoked permission.
        if (!Permissions.bleConnect(this) || !Permissions.bleAdvertise(this)) return
        val manager = getSystemService(BLUETOOTH_SERVICE) as BluetoothManager
        val adapter = manager.adapter ?: return
        if (!adapter.isEnabled) return
        val service = BluetoothGattService(serviceUuid, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        // Plain permissions, not *_ENCRYPTED_MITM. An MITM-encrypted characteristic cannot be
        // written over the first, unbonded connection a relay hop always starts with, so every
        // write was rejected and the transfer could never complete. The packet's own ECDSA
        // signature is what establishes trust; the link does not need to.
        dataChar = BluetoothGattCharacteristic(
            writeUuid,
            BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
            BluetoothGattCharacteristic.PERMISSION_WRITE
        )
        ackChar = BluetoothGattCharacteristic(
            ackUuid,
            BluetoothGattCharacteristic.PROPERTY_READ or BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            BluetoothGattCharacteristic.PERMISSION_READ
        )
        val cccd = BluetoothGattDescriptor(
            UUID.fromString("00002902-0000-1000-8000-00805f9b34fb"),
            BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE
        )
        ackChar?.addDescriptor(cccd)
        service.addCharacteristic(dataChar)
        service.addCharacteristic(ackChar)
        gattServer = manager.openGattServer(this, object : BluetoothGattServerCallback() {
            override fun onCharacteristicWriteRequest(
                device: BluetoothDevice,
                requestId: Int,
                ch: BluetoothGattCharacteristic,
                preparedWrite: Boolean,
                responseNeeded: Boolean,
                offset: Int,
                value: ByteArray
            ) {
                if (ch.uuid != writeUuid) {
                    if (responseNeeded) gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED, 0, null)
                    return
                }
                try {
                    val complete = transfer.accept(value)
                    if (complete != null) {
                        var accepted = false
                        var id = "unknown"
                        var hash = "0".repeat(64)
                        var reason = ""
                        try {
                            val packet = RelayProtocol.validate(complete)
                            id = packet.optString("k")
                            hash = packet.optString("x")
                            // Duplicate-safe: enqueue uses INSERT OR IGNORE on packet id
                            RelayForwarder.enqueue(this@RelayService, packet)
                            accepted = true
                        } catch (e: Exception) {
                            reason = e.message ?: "reject"
                        }
                        val ack = RelayProtocol.buildAck(id, hash, accepted, reason)
                        lastAck[device.address] = ack
                        ackChar?.value = ack
                        // Notify central
                        gattServer?.notifyCharacteristicChanged(device, ackChar, false)
                    }
                    if (responseNeeded) gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
                } catch (_: Exception) {
                    if (responseNeeded) gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, 0, null)
                }
            }

            override fun onCharacteristicReadRequest(
                device: BluetoothDevice,
                requestId: Int,
                offset: Int,
                characteristic: BluetoothGattCharacteristic
            ) {
                if (characteristic.uuid == ackUuid) {
                    val ack = lastAck[device.address] ?: RelayProtocol.buildAck("none", "0".repeat(64), false, "no_packet")
                    gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, ack)
                } else {
                    gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, offset, null)
                }
            }
        })
        gattServer?.addService(service)
        advertiser = adapter.bluetoothLeAdvertiser
        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_POWER)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_LOW)
            .setConnectable(true)
            .build()
        val data = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .addServiceUuid(ParcelUuid(serviceUuid))
            // The pairing beacon rides in manufacturer-specific data rather than service data: a
            // 128-bit UUID plus 128-bit service data is 40 bytes and overflows the 31-byte legacy
            // advertising PDU, which makes startAdvertising fail and the node undiscoverable.
            // Manufacturer data costs 2 (company id) + 2 (header) + 8 = 12 bytes, so the whole
            // payload stays inside the budget.
            .addManufacturerData(RelayProtocol.PAIRING_COMPANY_ID, RelayProtocol.buildPairingBeacon())
            .build()
        advertiser?.startAdvertising(settings, data, object : AdvertiseCallback() {
            override fun onStartFailure(errorCode: Int) {
                // Advertising is the *inbound* half of the relay. If it never starts, this node
                // cannot be discovered, so record it instead of leaving the UI to claim it is
                // listening. The outbound (scan/connect) half still works.
                advertiseError = "advertise_failed:$errorCode"
                advertisingOk = false
            }

            override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
                advertiseError = null
                advertisingOk = true
            }
        })
        running.set(true)
        isRunning = true
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        wifiRelay?.close()
        try { advertiser?.stopAdvertising(object : AdvertiseCallback() {}) } catch (_: Exception) {}
        try { gattServer?.close() } catch (_: Exception) {}
        running.set(false)
        isRunning = false
        advertisingOk = false
        super.onDestroy()
    }

    companion object {
        private const val TAG = "ReachRelay"
        /**
         * Process-wide view of the relay so the activity (and the PWA behind it) can report what is
         * actually happening instead of inferring "listening" from the permission grant alone.
         */
        @Volatile internal var isRunning = false
        @Volatile internal var advertisingOk = false
        @Volatile internal var advertiseError: String? = null
    }
}
