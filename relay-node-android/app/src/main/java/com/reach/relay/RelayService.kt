package com.reach.relay

import android.app.*
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.*
import android.os.*
import android.os.ParcelUuid
import androidx.core.app.NotificationCompat
import java.util.concurrent.atomic.AtomicBoolean

class RelayService: Service() {
    private var gattServer: BluetoothGattServer? = null
    private var advertiser: BluetoothLeAdvertiser? = null
    private val running=AtomicBoolean(false)
    private var wifiRelay:WifiDirectRelay?=null
    private val handler=Handler(Looper.getMainLooper())
    private val serviceUuid=java.util.UUID.fromString(RelayProtocol.SERVICE_UUID)
    private val writeUuid=java.util.UUID.fromString(RelayProtocol.DATA_UUID)
    private var characteristic: BluetoothGattCharacteristic?=null
    private val transfer = BleTransfer()

    override fun onBind(intent: Intent?)=null
    override fun onCreate(){ super.onCreate(); startForeground(7,notification()); RelayForwarder.init(this); startRelay(); startTransports(); scheduleForwarding() }

    private fun startTransports(){
        wifiRelay=WifiDirectRelay(this).also { w -> RelayForwarder.attachWifi(this,w); w.start({ peers -> peers.firstOrNull()?.let{w.connect(it)} }, { packet -> try{ val p=RelayProtocol.validate(packet); RelayForwarder.enqueue(this,p) }catch(_:Exception){} }, { host -> RelayForwarder.setWifiPeer(host) }) }
    }
    private fun scheduleForwarding(){ handler.postDelayed(object:Runnable{ override fun run(){ RelayForwarder.process(this@RelayService); handler.postDelayed(this,15000) } },1000) }
    private fun notification(): Notification {
        val channelId="reach-relay"
        val nm=getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(channelId,"REACH Relay",NotificationManager.IMPORTANCE_LOW))
        return NotificationCompat.Builder(this,channelId).setSmallIcon(android.R.drawable.stat_sys_data_bluetooth).setContentTitle("REACH relay active").setContentText("Listening for nearby emergency packets").setOngoing(true).build()
    }
    private fun startRelay(){
        val manager=getSystemService(BLUETOOTH_SERVICE) as BluetoothManager
        val adapter=manager.adapter ?: return
        if(!adapter.isEnabled) return
        val service=BluetoothGattService(serviceUuid,BluetoothGattService.SERVICE_TYPE_PRIMARY)
        characteristic=BluetoothGattCharacteristic(writeUuid,BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,BluetoothGattCharacteristic.PERMISSION_WRITE_ENCRYPTED_MITM)
        service.addCharacteristic(characteristic)
        gattServer=manager.openGattServer(this,object:BluetoothGattServerCallback(){
            override fun onCharacteristicWriteRequest(device:BluetoothDevice,requestId:Int,ch:BluetoothGattCharacteristic,preparedWrite:Boolean,responseNeeded:Boolean,value:ByteArray){
                if(ch.uuid!=writeUuid){ if(responseNeeded)gattServer?.sendResponse(device,requestId,BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED,0,null); return }
                try {
                    val complete = transfer.accept(value)
                    if (complete != null) {
                        val packet=RelayProtocol.validate(complete)
                        RelayForwarder.enqueue(this@RelayService,packet)
                    }
                    if(responseNeeded)gattServer?.sendResponse(device,requestId,BluetoothGatt.GATT_SUCCESS,0,null)
                } catch(_:Exception){ if(responseNeeded)gattServer?.sendResponse(device,requestId,BluetoothGatt.GATT_FAILURE,0,null) }
            }
        })
        gattServer?.addService(service)
        advertiser=adapter.bluetoothLeAdvertiser
        val settings=AdvertiseSettings.Builder().setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_POWER).setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_LOW).setConnectable(true).build()
        val data=AdvertiseData.Builder().setIncludeDeviceName(false).addServiceUuid(ParcelUuid(serviceUuid)).build()
        advertiser?.startAdvertising(settings,data,object:AdvertiseCallback(){})
        running.set(true)
    }
    override fun onDestroy(){ handler.removeCallbacksAndMessages(null); wifiRelay?.close(); advertiser?.stopAdvertising(object:AdvertiseCallback(){}); gattServer?.close(); running.set(false); super.onDestroy() }
}
