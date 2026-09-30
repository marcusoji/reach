import { appState } from './state.js';
import { buildRelayPacket, getRelayIdentity } from './relay/protocol.js';
import { detectRelayCapabilities } from './relay/capabilities.js';

const cfg = window.REACH_CONFIG || {};
const SUPABASE_URL = (cfg.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = cfg.SUPABASE_ANON_KEY || '';
const API_URL = (cfg.API_URL || `${SUPABASE_URL}/functions/v1/api`).replace(/\/$/, '');
const SESSION_KEY = 'reach_pwa_session';
const DB_NAME = 'reach-offline';
const STORE = 'incident-queue';
const QUEUE_MAX_ITEMS = 100;
const QUEUE_TTL_MS = 24 * 60 * 60 * 1000;
const backendConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
export { backendConfigured };

function getSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; } }
function setSession(session) { if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session)); else localStorage.removeItem(SESSION_KEY); }
function authHeaders(token) { return { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token || SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' }; }
function sessionFromAuth(data) { return { access_token:data.access_token, refresh_token:data.refresh_token, expires_at:data.expires_at || (data.expires_in ? Math.floor(Date.now()/1000)+Number(data.expires_in) : undefined), user:data.user }; }

export function hasSession() { return Boolean(getSession()?.access_token); }
async function registerRelayDevice(session){
  try{ if(!session?.access_token || !backendConfigured)return; const id=await getRelayIdentity(); await fetch(`${API_URL}/devices/register`,{method:'POST',headers:{...authHeaders(session.access_token)},body:JSON.stringify({device_id:id.deviceId,public_key:id.publicKeyB64,platform:'pwa',metadata:{transport:'web-bluetooth',protocol_version:2}})}); }catch{}
}
function syncNativeBridgeSession(session){ try { const bridge=window.REACH_NATIVE_RELAY; if(bridge?.configureSession && session?.access_token) bridge.configureSession(API_URL,session.access_token); } catch {} void registerRelayDevice(session); }

async function refreshSession() {
  const current = getSession(); if (!current?.refresh_token) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, { method:'POST', headers:{apikey:SUPABASE_ANON_KEY,'Content-Type':'application/json'}, body:JSON.stringify({refresh_token:current.refresh_token}) });
  const data = await res.json().catch(()=>({}));
  if (!res.ok || !data.access_token) { setSession(null); return null; }
  const next = sessionFromAuth(data); setSession(next); syncNativeBridgeSession(next); return next;
}
async function validSession() {
  const session=getSession(); if (!session) return null;
  if (!session.expires_at || session.expires_at*1000 > Date.now()+60000) return session;
  return refreshSession();
}

export async function signup({ email, password, fullName, phone }) {
  if (!backendConfigured) return { local:true };
  const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, { method:'POST', headers:{apikey:SUPABASE_ANON_KEY,'Content-Type':'application/json'}, body:JSON.stringify({email,password,data:{full_name:fullName,phone}}) });
  const data=await res.json().catch(()=>({})); if(!res.ok) throw new Error(data.msg||data.error_description||'Unable to create account');
  if(data.access_token){const session=sessionFromAuth(data);setSession(session);syncNativeBridgeSession(session);} return data;
}

export async function login({ email, password }) {
  if (!backendConfigured) return { local:true };
  const res=await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:SUPABASE_ANON_KEY,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
  const data=await res.json().catch(()=>({})); if(!res.ok) throw new Error(data.error_description||data.msg||'Unable to sign in');
  const session=sessionFromAuth(data); setSession(session); syncNativeBridgeSession(session); return data;
}

async function api(path, options={}, retry=true) {
  const session=await validSession();
  if(!session) throw new Error('NO_BACKEND_SESSION');
  const res=await fetch(`${API_URL}${path}`,{...options,headers:{...authHeaders(session.access_token),...(options.headers||{})}});
  if(res.status===401 && retry && session.refresh_token){await refreshSession();return api(path,options,false);}
  const data=await res.json().catch(()=>({})); if(!res.ok){const error=new Error(data.error||`Request failed (${res.status})`); error.status=res.status; throw error;} return data;
}

export async function createIncident(payload,idempotencyKey){const result=await api('/incidents',{method:'POST',headers:{'x-idempotency-key':idempotencyKey},body:JSON.stringify(payload)});return result.data;}
export async function getIncident(id){return (await api(`/incidents/${encodeURIComponent(id)}`)).data;}
export async function updateProfile(patch){return (await api('/me',{method:'PATCH',body:JSON.stringify(patch)})).data;}
export async function queueIncident(payload,idempotencyKey){const db=await openDb();const now=Date.now();await purgeExpired(db,now);const items=await allQueuedFromDb(db);if(items.length>=QUEUE_MAX_ITEMS){throw new Error('Offline emergency queue is full; reconnect to send pending emergencies before creating another queued report.');}await put(db,{id:idempotencyKey,payload,idempotencyKey,createdAt:now,attempts:0,nextAttemptAt:now});}
export async function flushQueue(){
  if(!backendConfigured || !navigator.onLine || !hasSession()) return {sent:0,remaining:await queueCount()};
  const db=await openDb();await purgeExpired(db,Date.now());const items=await allQueuedFromDb(db);let sent=0;
  for(const item of items.sort((a,b)=>a.createdAt-b.createdAt)){if(item.nextAttemptAt&&item.nextAttemptAt>Date.now())continue;try{const incident=await createIncident(item.payload,item.idempotencyKey);await removeQueued(item.id);localStorage.setItem('reach_last_incident',JSON.stringify({id:incident.id,code:incident.code}));if(appState.emergency.incidentId===item.idempotencyKey) { appState.emergency.incidentId=incident.id; appState.emergency.incidentCode=incident.code; }sent++;}catch{await markAttempt(db,item);break;}}
  return {sent,remaining:await queueCount()};
}
function openDb(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DB_NAME,2);req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE,{keyPath:'id'});if(!db.objectStoreNames.contains('sync-meta'))db.createObjectStore('sync-meta',{keyPath:'key'});};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
function put(db,value){return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put(value);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
function allQueued(){return openDb().then(async db=>{await purgeExpired(db,Date.now());return allQueuedFromDb(db);});}
function allQueuedFromDb(db){return new Promise((resolve,reject)=>{const req=db.transaction(STORE).objectStore(STORE).getAll();req.onsuccess=()=>resolve(req.result||[]);req.onerror=()=>reject(req.error);});}
function purgeExpired(db,now){return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');const store=tx.objectStore(STORE);const req=store.getAll();req.onsuccess=()=>{for(const item of req.result||[])if(!item.createdAt||now-item.createdAt>QUEUE_TTL_MS)store.delete(item.id);};tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
function markAttempt(db,item){return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');const next={...item,attempts:Number(item.attempts||0)+1,nextAttemptAt:Date.now()+Math.min(5*60*1000,Math.max(5000,2**Math.min(6,Number(item.attempts||0)+1)*1000))};tx.objectStore(STORE).put(next);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
function removeQueued(id){return openDb().then(db=>new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).delete(id);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);}));}
function queueCount(){return allQueued().then(items=>items.length).catch(()=>0);}

export function buildIncidentPayload(){const e=appState.emergency;const a=appState.aiDetection;return{
  category:e.category,title:`${e.categoryLabel} emergency`,description:`Citizen-confirmed ${e.categoryLabel.toLowerCase()} emergency from REACH PWA.`,priority:(e.priority||'high').toLowerCase(),source_channel:'pwa',delivery_method:navigator.onLine?'internet':'offline-queue',location_label:e.locationLabel,location_source:e.locationType==='gps'?'gps':e.locationType==='registered'?'registered':'manual',location_accuracy_m:e.locationAccuracyM,latitude:e.latitude,longitude:e.longitude,ai_confidence:Number(a.confidencePct||0),ai_fp_code:a.confidencePct?`FP-${String(e.category).toUpperCase()}-${Math.round(Number(a.confidencePct))}`:null,via_relay:false,location_context:{network:navigator.onLine?'online':'offline',relay_enabled:appState.relayEnabled}
};}

async function tryNativeRelay(payload,key){
  const bridge=window.REACH_NATIVE_RELAY;
  if(!bridge || typeof bridge.sendPacket!=='function' || !appState.relayEnabled) return null;
  const built=await buildRelayPacket({packetKey:key,incidentId:null,category:payload.category,priority:payload.priority,title:payload.title,description:payload.description,locationLabel:payload.location_label,locationSource:payload.location_source,locationAccuracyM:payload.location_accuracy_m,latitude:payload.latitude,longitude:payload.longitude});
  const accepted=await bridge.sendPacket(JSON.stringify(built.packet));
  if(accepted===false || accepted==='false') throw new Error('Native relay did not accept the packet');
  return {status:'relay-queued',packet:built.packet};
}

export async function sendOrQueueEmergency(){
  const payload=buildIncidentPayload(); const key=`pwa-${crypto.randomUUID()}`;
  try{
    if(!navigator.onLine){
      try{const relayed=await tryNativeRelay(payload,key); if(relayed){appState.emergency.incidentId=null;appState.emergency.incidentCode=key.slice(-8).toUpperCase();appState.emergency.deliveryMethod='Native relay';localStorage.setItem('reach_relay_packet_key',key);return relayed;}}catch{}
      throw new Error('OFFLINE');
    }
    const incident=await createIncident(payload,key);appState.emergency.incidentId=incident.id;appState.emergency.incidentCode=incident.code||incident.id;appState.emergency.deliveryMethod='Connected gateway';return{status:'sent',incident};
  }catch(error){
    const retryable=!error.status || error.status>=500 || error.status===429;
    if(!retryable) return {status:'failed',error};
    await queueIncident(payload,key);appState.emergency.incidentId=key;appState.emergency.incidentCode=key.slice(-8).toUpperCase();appState.emergency.deliveryMethod=hasSession()?'Waiting for connection':'Saved locally — sign in when connected';return{status:'queued',error};
  }
}

export async function getContacts(){return (await api('/contacts')).data;}
export async function addContact(contact){return (await api('/contacts',{method:'POST',body:JSON.stringify(contact)})).data;}
export async function deleteContact(id){await api(`/contacts/${encodeURIComponent(id)}`,{method:'DELETE'});}
export async function getRelayCapabilities(){ return detectRelayCapabilities(); }
export function initBackendSync(){window.addEventListener('online',()=>{void flushQueue();});window.setInterval(()=>{if(navigator.onLine)void flushQueue();},30000);void flushQueue();}
