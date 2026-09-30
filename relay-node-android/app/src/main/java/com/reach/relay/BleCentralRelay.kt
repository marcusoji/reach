package com.reach.relay

import android.Manifest
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import java.util.UUID

/** Native BLE central: discovers REACH relay nodes and pushes authenticated packets using bounded fragments. */
class BleCentralRelay(private val context:Context, private val onPeer:(Boolean)->Unit={}) {
    private val adapter=(context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
    private var scanner:BluetoothLeScanner?=null
    private var gatt:BluetoothGatt?=null
    private var characteristic:BluetoothGattCharacteristic?=null
    private var pending:ByteArray?=null
    private var seq=0
    private var total=0
    private var transfer=ByteArray(16)
    private var completion:(Boolean)->Unit={}
    private val service=UUID.fromString(RelayProtocol.SERVICE_UUID)
    private val data=UUID.fromString(RelayProtocol.DATA_UUID)

    fun discoverAndSend(packet:ByteArray, onComplete:(Boolean)->Unit={}){
        if(!permissions()||adapter==null||!adapter.isEnabled)return
        pending=packet; completion=onComplete; scanner=adapter.bluetoothLeScanner
        scanner?.startScan(listOf(ScanFilter.Builder().setServiceUuid(android.os.ParcelUuid(service)).build()),ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(),scanCallback); Handler(Looper.getMainLooper()).postDelayed({ scanner?.stopScan(scanCallback); if(pending!=null){pending=null;completion(false);completion={}} },8000)
    }
    private val scanCallback=object:ScanCallback(){override fun onScanResult(type:Int,result:ScanResult){scanner?.stopScan(this); gatt=result.device.connectGatt(context,false,gattCallback)}}
    private val gattCallback=object:BluetoothGattCallback(){
        override fun onConnectionStateChange(g:BluetoothGatt,status:Int,newState:Int){if(newState==BluetoothProfile.STATE_CONNECTED){g.discoverServices()}else if(newState==BluetoothProfile.STATE_DISCONNECTED){g.close();completion(false);completion={};onPeer(false)}}
        override fun onServicesDiscovered(g:BluetoothGatt,status:Int){if(status!=BluetoothGatt.GATT_SUCCESS){g.close();return};characteristic=g.getService(service)?.getCharacteristic(data);if(characteristic==null){g.close();return};pending?.let{startFragments(it)}}
        override fun onCharacteristicWrite(g:BluetoothGatt,ch:BluetoothGattCharacteristic,status:Int){if(status!=BluetoothGatt.GATT_SUCCESS){g.close();return};sendNext(g)}
    }
    private fun startFragments(bytes:ByteArray){transfer=java.security.SecureRandom().generateSeed(16);total=Math.ceil(bytes.size/RelayProtocol.CHUNK_BYTES.toDouble()).toInt();seq=0;sendNext(gatt!!)}
    private fun sendNext(g:BluetoothGatt){val bytes=pending?:return;if(seq>=total){pending=null;g.close();completion(true);completion={};onPeer(true);return};val start=seq*RelayProtocol.CHUNK_BYTES;val body=bytes.copyOfRange(start,minOf(bytes.size,start+RelayProtocol.CHUNK_BYTES));val frame=ByteArray(20+body.size);System.arraycopy(transfer,0,frame,0,16);frame[16]=(seq ushr 8).toByte();frame[17]=seq.toByte();frame[18]=(total ushr 8).toByte();frame[19]=total.toByte();System.arraycopy(body,0,frame,20,body.size);characteristic!!.writeType=BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT;characteristic!!.value=frame;if(!g.writeCharacteristic(characteristic!!)){g.close();completion(false);completion={};return};seq++}
    private fun permissions():Boolean=if(Build.VERSION.SDK_INT>=31) listOf(Manifest.permission.BLUETOOTH_SCAN,Manifest.permission.BLUETOOTH_CONNECT).all{ContextCompat.checkSelfPermission(context,it)==PackageManager.PERMISSION_GRANTED}else true
}
