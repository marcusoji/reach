const VERSION=2;
export const RELAY_LIMITS=Object.freeze({maxHops:6,ttlMs:30*60*1000,maxBytes:4096,bleChunkBytes:180});
const enc=v=>new TextEncoder().encode(v);
const b64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromB64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const hex=buf=>[...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
const cv=v=>v&&typeof v==='object'?JSON.stringify(v):String(v); const canonicalSource=p=>['v','k','e','m','incident_id','source_device_id','x','minimal_payload'].map(k=>`${k}=${cv(p[k])}`).join('&');
const canonicalRelay=p=>['v','k','e','h','m','incident_id','source_device_id','x','relay_device_id','minimal_payload'].map(k=>`${k}=${cv(p[k])}`).join('&');
async function digest(s){return hex(await crypto.subtle.digest('SHA-256',enc(s)));}
export async function getRelayIdentity(){
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('reach-relay',1);r.onupgradeneeded=()=>r.result.createObjectStore('identity');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
  const get=()=>new Promise((resolve,reject)=>{const tx=db.transaction('identity','readonly');const r=tx.objectStore('identity').get('v2');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
  let saved=await get(); if(saved)return saved;
  const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const publicKey=await crypto.subtle.exportKey('spki',pair.publicKey); const publicKeyB64=b64(publicKey); const deviceId=(await digest(publicKeyB64)).slice(0,24);
  saved={privateKey:pair.privateKey,publicKey:pair.publicKey,publicKeyB64,deviceId};
  await new Promise((resolve,reject)=>{const tx=db.transaction('identity','readwrite');tx.objectStore('identity').put(saved,'v2');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});return saved;
}
function p1363ToDer(raw){
  const r=raw.slice(0,32),s=raw.slice(32); const trim=x=>{let i=0;while(i<x.length-1&&x[i]===0)i++;let y=x.slice(i);if(y[0]&0x80)y=new Uint8Array([0,...y]);return y};const rr=trim(r),ss=trim(s);const body=new Uint8Array(2+rr.length+2+ss.length);let i=0;body[i++]=2;body[i++]=rr.length;body.set(rr,i);i+=rr.length;body[i++]=2;body[i++]=ss.length;body.set(ss,i);const head=body.length<128?new Uint8Array([0x30,body.length]):new Uint8Array([0x30,0x81,body.length]);const out=new Uint8Array(head.length+body.length);out.set(head);out.set(body,head.length);return out;}
export async function buildRelayPacket({packetKey,incidentId,category,priority,locationLabel,locationSource,latitude,longitude,createdAt=Date.now(),ttlMs=RELAY_LIMITS.ttlMs,hopCount=0,maxHops=RELAY_LIMITS.maxHops}){
  const id=await getRelayIdentity(); const expiresAt=createdAt+Math.min(Math.max(ttlMs,10_000),RELAY_LIMITS.ttlMs); if(hopCount<0||hopCount>=maxHops)throw new Error('Invalid hop count');
  const minimal={category,priority,locationLabel,locationSource,latitude:latitude??null,longitude:longitude??null,createdAt};
  const p={v:VERSION,k:packetKey,incident_id:incidentId,e:expiresAt,h:hopCount,m:Math.min(maxHops,RELAY_LIMITS.maxHops),source_device_id:id.deviceId,minimal_payload:minimal};
  p.x=await digest(canonicalSource(p)); const signed=canonicalSource(p); const rawSig=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},id.privateKey,enc(signed));
  p.source_public_key=id.publicKeyB64;p.source_signed_payload=signed;p.source_signature=b64(p1363ToDer(rawSig));
  const bytes=enc(JSON.stringify(p)).byteLength;if(bytes>RELAY_LIMITS.maxBytes)throw new Error('Relay packet exceeds size limit');
  return {packet:p,hash:p.x,bytes};
}
export function validateRelayPacket(packet){if(!packet||packet.v!==VERSION||typeof packet.k!=='string'||typeof packet.x!=='string')return{ok:false,error:'Invalid packet'};if(Date.now()>Number(packet.e))return{ok:false,error:'Packet expired'};if(Number(packet.h)<0||Number(packet.h)>=Number(packet.m)||Number(packet.m)>RELAY_LIMITS.maxHops)return{ok:false,error:'Hop limit reached'};return{ok:true};}

export async function connectBluetoothRelay({serviceUuid,dataCharacteristicUuid}){
  if(!navigator.bluetooth?.requestDevice)throw new Error('Web Bluetooth is unavailable in this browser.');
  const device=await navigator.bluetooth.requestDevice({filters:[{services:[serviceUuid]}]}); const server=await device.gatt?.connect(); const service=await server?.getPrimaryService(serviceUuid); const characteristic=await service?.getCharacteristic(dataCharacteristicUuid); if(!characteristic)throw new Error('REACH relay characteristic unavailable.'); return{device,characteristic};
}

export async function sendBluetoothPacket(connection,packet){
  const bytes=enc(JSON.stringify(packet)); if(bytes.byteLength>RELAY_LIMITS.maxBytes)throw new Error('Relay packet exceeds maximum size.');
  const transfer=crypto.getRandomValues(new Uint8Array(16)); const total=Math.ceil(bytes.byteLength/RELAY_LIMITS.bleChunkBytes); if(total>64)throw new Error('Relay packet needs too many BLE fragments.');
  for(let seq=0;seq<total;seq++){const start=seq*RELAY_LIMITS.bleChunkBytes;const body=bytes.slice(start,start+RELAY_LIMITS.bleChunkBytes);const frame=new Uint8Array(20+body.length);frame.set(transfer,0);new DataView(frame.buffer).setUint16(16,seq);new DataView(frame.buffer).setUint16(18,total);frame.set(body,20);await connection.characteristic.writeValueWithResponse(frame);}
}
