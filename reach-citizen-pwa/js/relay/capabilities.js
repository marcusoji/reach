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

// The Web Bluetooth connect/send helpers live in relay/protocol.js (the module that also
// defines the packet format and framing). They were previously duplicated here, which let
// the two copies drift; import from protocol.js instead.
