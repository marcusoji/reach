package com.reach.relay

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
import androidx.core.app.NotificationCompat
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Peripheral: advertise REACH relay service, accept BLE fragments, validate, persist, ACK.
 * Also runs Wi-Fi ACK server and periodic queue drain/cleanup.
 */
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
        startForeground(42, buildNotification())
        startRelay()
        wifiRelay = WifiDirectRelay(this).also { wr ->
            wr.startAckServer(this) { packet ->
                RelayForwarder.enqueue(this, packet)
            }
        }
        // Periodic purge + drain
        handler.post(object : Runnable {
            override fun run() {
                try {
                    val db = RelayQueueDb(this@RelayService)
                    db.purgeExpired()
                    db.recoverStaleSending()
                } catch (_: Exception) {}
                RelayForwarder.kick(this@RelayService)
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
        return NotificationCompat.Builder(this, channelId)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentTitle("REACH relay active")
            .setContentText("Listening for nearby emergency packets")
            .setOngoing(true)
            .build()
    }

    private fun startRelay() {
        val manager = getSystemService(BLUETOOTH_SERVICE) as BluetoothManager
        val adapter = manager.adapter ?: return
        if (!adapter.isEnabled) return
        val service = BluetoothGattService(serviceUuid, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        dataChar = BluetoothGattCharacteristic(
            writeUuid,
            BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
            BluetoothGattCharacteristic.PERMISSION_WRITE_ENCRYPTED_MITM
        )
        ackChar = BluetoothGattCharacteristic(
            ackUuid,
            BluetoothGattCharacteristic.PROPERTY_READ or BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            BluetoothGattCharacteristic.PERMISSION_READ_ENCRYPTED_MITM
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
            .build()
        advertiser?.startAdvertising(settings, data, object : AdvertiseCallback() {})
        running.set(true)
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        wifiRelay?.close()
        try { advertiser?.stopAdvertising(object : AdvertiseCallback() {}) } catch (_: Exception) {}
        try { gattServer?.close() } catch (_: Exception) {}
        running.set(false)
        super.onDestroy()
    }
}
