export async function detectRelayCapabilities(){
  const bluetooth = typeof navigator!=='undefined' && 'bluetooth' in navigator;
  let bluetoothAvailable=false;
  if(bluetooth && navigator.bluetooth.getAvailability){ try{ bluetoothAvailable=await navigator.bluetooth.getAvailability(); }catch{} }
  const webrtc = typeof RTCPeerConnection!=='undefined';
  const networkInfo = navigator.connection ? { type:navigator.connection.type || 'unknown', effectiveType:navigator.connection.effectiveType || 'unknown' } : {type:'unknown',effectiveType:'unknown'};
  const nativeRelay = typeof window!=='undefined' && !!window.REACH_NATIVE_RELAY;
  return {
    nativeRelay,
    bluetoothApi:bluetooth,
    bluetoothAvailable,
    bluetoothMode:nativeRelay?'native-gatt-relay':(bluetoothAvailable?'browser-central-only':'unavailable'),
    webrtc,
    webrtcMode:webrtc?'opportunistic-peer-data-channel':'unavailable',
    wifiDirectBrowserApi:false,
    wifiMode:nativeRelay?'native-wifi-direct-relay':'native-relay-required',
    backgroundRelayGuaranteed:false,
    recommendedPath:nativeRelay?'native-relay-node':'offline-queue-until-connectivity',
    networkInfo
  };
}

export async function connectBluetoothRelay({serviceUuid,writeCharacteristicUuid}){
  if(!navigator.bluetooth?.requestDevice) throw new Error('Web Bluetooth is unavailable in this browser.');
  const device=await navigator.bluetooth.requestDevice({filters:[{services:[serviceUuid]}]});
  const server=await device.gatt?.connect();
  const service=await server?.getPrimaryService(serviceUuid);
  const characteristic=await service?.getCharacteristic(writeCharacteristicUuid);
  if(!characteristic) throw new Error('Relay characteristic is unavailable.');
  return {device,characteristic};
}

export async function sendBluetoothPacket(connection,packet){
  const bytes=new TextEncoder().encode(JSON.stringify(packet));
  if(bytes.byteLength>512) throw new Error('BLE packet is too large; use fragmentation in the native relay adapter.');
  await connection.characteristic.writeValue(bytes);
}
