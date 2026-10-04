export async function detectRelayCapabilities(){
  const bluetooth = typeof navigator!=='undefined' && 'bluetooth' in navigator;
  let bluetoothAvailable=false;
  if(bluetooth && navigator.bluetooth.getAvailability){ try{ bluetoothAvailable=await navigator.bluetooth.getAvailability(); }catch{} }
  const webrtc = typeof RTCPeerConnection!=='undefined';
  const networkInfo = navigator.connection ? { type:navigator.connection.type || 'unknown', effectiveType:navigator.connection.effectiveType || 'unknown' } : {type:'unknown',effectiveType:'unknown'};
  const nativeRelay = typeof window!=='undefined' && !!window.REACH_NATIVE_RELAY;
  // A plain browser can hand a signed packet to a nearby relay node's GATT service over Web
  // Bluetooth. It is foreground-only (the page must be open and the device chosen from a gesture),
  // but it is a real relay path when no native node is present.
  const directRelay = !nativeRelay && bluetooth && typeof navigator.bluetooth.requestDevice==='function';
  return {
    nativeRelay,
    directRelay,
    bluetoothApi:bluetooth,
    bluetoothAvailable,
    bluetoothMode:nativeRelay?'native-gatt-relay':(directRelay?'browser-direct-relay':(bluetoothAvailable?'browser-central-only':'unavailable')),
    webrtc,
    webrtcMode:webrtc?'opportunistic-peer-data-channel':'unavailable',
    wifiDirectBrowserApi:false,
    wifiMode:nativeRelay?'native-wifi-direct-relay':'native-relay-required',
    backgroundRelayGuaranteed:false,
    recommendedPath:nativeRelay?'native-relay-node':(directRelay?'browser-direct-relay':'offline-queue-until-connectivity'),
    networkInfo
  };
}

// The Web Bluetooth connect/send helpers live in relay/protocol.js (the module that also
// defines the packet format and framing). They were previously duplicated here, which let
// the two copies drift; import from protocol.js instead.
