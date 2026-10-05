import { appState } from './state.js';
import { buildRelayPacket, getRelayIdentity, toServerPacket } from './relay/protocol.js';
import { detectRelayCapabilities } from './relay/capabilities.js';
import { directRelayAvailable, directRelayConnection, connectDirectRelay, sendPacketViaDirectRelay, probeDirectRelay } from './relay/direct.js';

const cfg = window.REACH_CONFIG || {};
const SUPABASE_URL = (cfg.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = cfg.SUPABASE_ANON_KEY || '';
const API_URL = (cfg.API_URL || `${SUPABASE_URL}/functions/v1/api`).replace(/\/$/, '');
const SESSION_KEY = 'reach_pwa_session';
const DB_NAME = 'reach-offline';
// One version for the whole database. IndexedDB throws VersionError if a connection is opened at a
// lower version than the existing one, so every module that opens `reach-offline` must agree;
// evidence.js owns the same constant and creates the evidence-queue store.
const DB_VERSION = 4;
const STORE = 'incident-queue';
const RELAY_STORE = 'relay-queue';
const QUEUE_STATE_QUEUED = 'queued';
const QUEUE_STATE_RETRYING = 'retrying';
const QUEUE_STATE_DEAD = 'dead_letter';
const QUEUE_STATE_EXPIRED = 'expired';
const QUEUE_STATE_SENT = 'sent';
const QUEUE_MAX_ATTEMPTS = 8;

const QUEUE_MAX_ITEMS = 100;
const QUEUE_TTL_MS = 24 * 60 * 60 * 1000;
// Relay packets carry their own expiry (`e`). A packet past it can never be accepted by the
// gateway, so it is dropped rather than retried; failed sends back off and dead-letter.
const RELAY_QUEUE_MAX_ATTEMPTS = 8;
const RELAY_QUEUE_MAX_ITEMS = 50;
const backendConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
export { backendConfigured };

// Bound every request. Without this a hung socket leaves the UI spinning forever, and a CORS
// rejection (which the browser reports as an opaque TypeError) was surfaced as "Failed to
// fetch" with no explanation — and the post-signup profile sync made it look like the whole
// registration had failed even though the account already existed.
const REQUEST_TIMEOUT_MS = Number((typeof window !== 'undefined' && window.REACH_REQUEST_TIMEOUT_MS) || 0) || 20000;
async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw new Error('REACH took too long to respond. Check your connection and try again.');
    }
    throw new Error('Could not reach REACH. Check your connection and try again.');
  } finally { clearTimeout(timer); }
}

function getSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; } }
function setSession(session) { if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session)); else localStorage.removeItem(SESSION_KEY); }
function authHeaders(token) { return { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token || SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' }; }
function sessionFromAuth(data) { return { access_token:data.access_token, refresh_token:data.refresh_token, expires_at:data.expires_at || (data.expires_in ? Math.floor(Date.now()/1000)+Number(data.expires_in) : undefined), user:data.user }; }

export function hasSession() { return Boolean(getSession()?.access_token); }
async function registerRelayDevice(session){
  try{ if(!session?.access_token || !backendConfigured)return; const id=await getRelayIdentity(); await fetchWithTimeout(`${API_URL}/devices/register`,{method:'POST',headers:{...authHeaders(session.access_token)},body:JSON.stringify({device_id:id.deviceId,public_key:id.publicKeyB64,platform:'pwa',metadata:{transport:'web-bluetooth',protocol_version:2}})}); }catch{}
}
function syncNativeBridgeSession(session){ try { const bridge=window.REACH_NATIVE_RELAY; if(bridge?.configureSession && session?.access_token) bridge.configureSession(API_URL,session.access_token,SUPABASE_ANON_KEY); } catch {} void registerRelayDevice(session); }

async function refreshSession() {
  const current = getSession(); if (!current?.refresh_token) return null;
  const res = await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, { method:'POST', headers:{apikey:SUPABASE_ANON_KEY,'Content-Type':'application/json'}, body:JSON.stringify({refresh_token:current.refresh_token}) });
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
  const res = await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/signup`, { method:'POST', headers:{apikey:SUPABASE_ANON_KEY,'Content-Type':'application/json'}, body:JSON.stringify({email,password,data:{full_name:fullName,phone}}) });
  const data=await res.json().catch(()=>({})); if(!res.ok) throw new Error(data.msg||data.error_description||'Unable to create account');
  if(data.access_token){const session=sessionFromAuth(data);setSession(session);syncNativeBridgeSession(session);} return data;
}

export async function login({ email, password }) {
  if (!backendConfigured) return { local:true };
  const res=await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:SUPABASE_ANON_KEY,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
  const data=await res.json().catch(()=>({})); if(!res.ok) throw new Error(data.error_description||data.msg||'Unable to sign in');
  const session=sessionFromAuth(data); setSession(session); syncNativeBridgeSession(session); return data;
}

async function api(path, options={}, retry=true) {
  const session=await validSession();
  if(!session) throw new Error('NO_BACKEND_SESSION');
  const res=await fetchWithTimeout(`${API_URL}${path}`,{...options,headers:{...authHeaders(session.access_token),...(options.headers||{})}});
  if(res.status===401 && retry && session.refresh_token){await refreshSession();return api(path,options,false);}
  const data=await res.json().catch(()=>({})); if(!res.ok){const error=new Error(data.error||`Request failed (${res.status})`); error.status=res.status; throw error;} return data;
}

export async function createIncident(payload,idempotencyKey){const result=await api('/incidents',{method:'POST',headers:{'x-idempotency-key':idempotencyKey},body:JSON.stringify(payload)});return result.data;}

/** Upload a signed relay packet to the gateway (connected path, no radio hop). */
export async function sendRelayPacket(packet){const result=await api('/relay/packets',{method:'POST',body:JSON.stringify(toServerPacket(packet,'pwa'))});return result.data;}

/**
 * Hand a queued signed packet to this device's native relay node.
 *
 * The node carries it over Bluetooth/Wi-Fi Direct when there is no internet, and uploads it itself
 * when a connection returns. Returns true only when the node accepted it; false (never throws) when
 * there is no native bridge, the relay is disabled, or the node rejected the packet.
 */
function handPacketToNativeRelay(packet){
  try{
    const bridge=window.REACH_NATIVE_RELAY;
    if(!bridge || typeof bridge.sendPacket!=='function' || !appState.relayEnabled) return false;
    const raw=bridge.sendPacket(JSON.stringify(packet));
    if(raw===false || raw==='false') return false;
    if(typeof raw==='string'){ try{ return JSON.parse(raw)?.accepted!==false; }catch{ return true; } }
    if(raw && typeof raw==='object') return raw.accepted!==false;
    return true;
  }catch{ return false; }
}

/** Flush signed relay packets queued while offline. Each item holds {id,packet}.
 * A packet whose own TTL (`packet.e`) has passed is discarded; a send that fails backs off
 * with exponential delay and dead-letters after RELAY_QUEUE_MAX_ATTEMPTS instead of being
 * retried every 30s forever.
 *
 * With no internet the packet is first offered to this device's native relay node, so a node whose
 * radios are on actually carries it to a nearby phone instead of waiting for a connection that may
 * never come. Handing it over deletes the local row: the node now owns delivery. */
export async function flushRelayQueue(){
  const db=await openDb();
  let items=[];
  try{ items=await new Promise((resolve,reject)=>{const req=db.transaction(RELAY_STORE).objectStore(RELAY_STORE).getAll();req.onsuccess=()=>resolve(req.result||[]);req.onerror=()=>reject(req.error);}); }catch{ return {sent:0,remaining:0,dead:0,expired:0,relayed:0}; }
  const remove=(id)=>new Promise((resolve,reject)=>{const tx=db.transaction(RELAY_STORE,'readwrite');tx.objectStore(RELAY_STORE).delete(id);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});
  const put=(value)=>new Promise((resolve,reject)=>{const tx=db.transaction(RELAY_STORE,'readwrite');tx.objectStore(RELAY_STORE).put(value);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});
  const online=navigator.onLine && hasSession();
  let sent=0, dead=0, expired=0, relayed=0;
  for(const item of items.sort((a,b)=>(a.createdAt||0)-(b.createdAt||0))){
    if(item.state==='dead_letter'){ dead++; continue; }
    if(item.nextAttemptAt && item.nextAttemptAt>Date.now()) continue;
    if(Date.now()>=Number(item.packet?.e||0)){ await remove(item.id); expired++; continue; }
    if(!online){
      // Offline: the radios are the only way out. A node without one keeps the packet queued.
      if(handPacketToNativeRelay(item.packet)){ await remove(item.id); relayed++; }
      continue;
    }
    try{ await sendRelayPacket(item.packet); await remove(item.id); sent++; }
    catch(err){
      const attempts=Number(item.attempts||0)+1;
      const next={...item,attempts,lastError:String(err&&err.message||err).slice(0,300),nextAttemptAt:Date.now()+Math.min(120000,1000*Math.pow(2,attempts))};
      if(attempts>=RELAY_QUEUE_MAX_ATTEMPTS){ next.state='dead_letter'; next.deadAt=Date.now(); dead++; }
      await put(next);
    }
  }
  const rows=await new Promise((resolve,reject)=>{const req=db.transaction(RELAY_STORE).objectStore(RELAY_STORE).getAll();req.onsuccess=()=>resolve(req.result||[]);req.onerror=()=>reject(req.error);});
  return {sent,relayed,remaining:rows.filter(i=>i.state!=='dead_letter').length,dead,expired};
}
function queueRelayPacket(packet){return openDb().then(db=>new Promise((resolve,reject)=>{
  const req=db.transaction(RELAY_STORE).objectStore(RELAY_STORE).getAll();
  req.onsuccess=()=>{
    const live=(req.result||[]).filter(i=>i.state!=='dead_letter');
    if(live.length>=RELAY_QUEUE_MAX_ITEMS)return reject(new Error('Relay queue is full; reconnect to send pending relay packets.'));
    const tx=db.transaction(RELAY_STORE,'readwrite');
    tx.objectStore(RELAY_STORE).put({id:packet.k,packet,createdAt:Date.now(),attempts:0,state:'queued'});
    tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);
  };
  req.onerror=()=>reject(req.error);
}));}
/** Relay dead letters, mirroring listDeadLetter for the incident queue. */
export async function listRelayDeadLetter(){
  const db=await openDb().catch(()=>null); if(!db) return [];
  const rows=await new Promise((resolve,reject)=>{const req=db.transaction(RELAY_STORE).objectStore(RELAY_STORE).getAll();req.onsuccess=()=>resolve(req.result||[]);req.onerror=()=>reject(req.error);}).catch(()=>[]);
  return rows.filter(i=>i.state==='dead_letter');
}
/** Live relay-queue rows (pending + dead) so the UI can show what is actually waiting to move. */
export async function listRelayQueue(){
  const db=await openDb().catch(()=>null); if(!db) return [];
  return new Promise((resolve,reject)=>{const req=db.transaction(RELAY_STORE).objectStore(RELAY_STORE).getAll();req.onsuccess=()=>resolve(req.result||[]);req.onerror=()=>reject(req.error);}).catch(()=>[]);
}

/**
 * The signed relay packets waiting on this device, as a portable JSON document.
 *
 * A phone with no relay node and no internet can save this file and hand it to any REACH relay node
 * over Bluetooth or Wi-Fi file transfer; the packets are already source-signed, so the receiving
 * node uploads them unchanged (it adds only its own relay envelope). Expired and dead-lettered
 * packets are excluded — the gateway would reject them.
 */
export async function exportRelayPackets(){
  // Inside the relay-node app the node owns the durable queue, including packets it received over
  // the radio. Export that when it has anything, so "Save alert file to transfer" hands on what the
  // node actually holds; fall back to this device's IndexedDB rows otherwise.
  const bridge=typeof window!=='undefined'?window.REACH_NATIVE_RELAY:null;
  if(bridge && typeof bridge.exportRelayFile==='function'){
    try{
      const raw=bridge.exportRelayFile();
      if(typeof raw==='string' && raw){
        const doc=JSON.parse(raw);
        if(Array.isArray(doc?.packets) && doc.packets.length) return doc;
      }
    }catch{ /* fall back to the local queue */ }
  }
  const rows=await listRelayQueue();
  const now=Date.now();
  const packets=rows
    .filter(r=>r.state!=='dead_letter' && Number(r.packet?.e||0)>now)
    .sort((a,b)=>(a.createdAt||0)-(b.createdAt||0))
    .map(r=>r.packet);
  return {format:'reach-relay-packets',version:1,exported_at:new Date().toISOString(),packets};
}

/**
 * Queue relay packets that were handed to this device as a file (the receiving half of the export).
 *
 * A relay node that has no radio peer can still receive a citizen's signed packets as a JSON file
 * (Bluetooth/Wi-Fi file transfer, USB, etc.) and upload them on its next connection. The packets
 * are already source-signed, so this only sanity-checks structure and expiry — the gateway is the
 * authority on signatures and device registration, exactly as for a packet that arrived over the
 * radio. Returns how many were accepted, skipped (expired/malformed/duplicate) and rejected.
 */
export async function importRelayPackets(input){
  const list=Array.isArray(input)?input:(Array.isArray(input?.packets)?input.packets:null);
  if(!list) throw new Error('Not a REACH relay packet file.');
  // Inside the relay-node app the native queue owns delivery, so hand the file to the node and let
  // it carry the packets; only fall back to this device's IndexedDB queue in a plain browser.
  const bridge=typeof window!=='undefined'?window.REACH_NATIVE_RELAY:null;
  if(bridge && typeof bridge.importRelayFile==='function'){
    try{
      const raw=bridge.importRelayFile(JSON.stringify(input));
      const result=typeof raw==='string'?JSON.parse(raw):raw;
      if(result && typeof result.accepted==='number') return {accepted:result.accepted,skipped:Number(result.skipped||0),rejected:Number(result.rejected||0)};
    }catch{ /* fall back to the local queue */ }
  }
  const now=Date.now();
  const db=await openDb();
  const existing=await new Promise((resolve,reject)=>{const req=db.transaction(RELAY_STORE).objectStore(RELAY_STORE).getAll();req.onsuccess=()=>resolve(req.result||[]);req.onerror=()=>reject(req.error);}).catch(()=>[]);
  const live=new Set(existing.filter(r=>r.state!=='dead_letter').map(r=>r.id));
  let accepted=0, skipped=0, rejected=0;
  for(const packet of list){
    const valid=packet && typeof packet==='object'
      && typeof packet.k==='string' && packet.k
      && typeof packet.x==='string' && packet.x
      && typeof packet.source_signature==='string' && packet.source_signature
      && typeof packet.source_signed_payload==='string' && packet.source_signed_payload
      && typeof packet.source_device_id==='string' && packet.source_device_id
      && typeof packet.source_public_key==='string' && packet.source_public_key;
    if(!valid){ rejected++; continue; }
    if(!(Number(packet.e)>now)){ skipped++; continue; }
    if(live.has(packet.k) || live.size>=RELAY_QUEUE_MAX_ITEMS){ skipped++; continue; }
    try{
      await new Promise((resolve,reject)=>{const tx=db.transaction(RELAY_STORE,'readwrite');tx.objectStore(RELAY_STORE).put({id:packet.k,packet,createdAt:now,attempts:0,state:'queued'});tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});
      live.add(packet.k); accepted++;
    }catch{ rejected++; }
  }
  return {accepted,skipped,rejected};
}
export async function getIncident(id){return (await api(`/incidents/${encodeURIComponent(id)}`)).data;}

const HISTORY_CACHE_KEY='reach_incident_history';

/** The signed-in citizen's own incident history, newest first.
 *
 * `/incidents` is RLS-scoped to rows this user can see (their own reports, their institution's, or
 * everything for an operator/super-admin), so the list is filtered to rows this user reported.
 * The result is cached so the history screen still has something to show with no connection.
 */
export async function getIncidentHistory({refresh=true}={}){
  const cached=readHistoryCache();
  if(!refresh) return cached;
  if(!backendConfigured || !hasSession()) return cached;
  try{
    const rows=(await api('/incidents?limit=50')).data||[];
    const mine=filterOwnIncidents(rows);
    writeHistoryCache(mine);
    return mine;
  }catch{ return cached; }
}

/** Keep only incidents this user reported. A row without a reporter_id (older shape) is kept. */
export function filterOwnIncidents(rows){
  const userId=getSession()?.user?.id;
  if(!userId) return rows||[];
  return (rows||[]).filter(r=>!r.reporter_id || r.reporter_id===userId);
}

function readHistoryCache(){ try{ const raw=JSON.parse(localStorage.getItem(HISTORY_CACHE_KEY)||'[]'); return Array.isArray(raw)?raw:[]; }catch{ return []; } }
function writeHistoryCache(rows){ try{ localStorage.setItem(HISTORY_CACHE_KEY,JSON.stringify(rows.slice(0,50))); }catch{ /* storage full or unavailable */ } }

export async function updateProfile(patch){return (await api('/me',{method:'PATCH',body:JSON.stringify(patch)})).data;}
/** The signed-in profile, including the estate this citizen belongs to (institution_name). */
export async function getProfile(){return (await api('/me')).data;}
/** Join an estate with an institution-issued join code, so this citizen's reports route to it. */
export async function joinInstitution(code){return (await api('/citizen/join',{method:'POST',body:JSON.stringify({code})})).data;}
export async function queueIncident(payload,idempotencyKey){const db=await openDb();const now=Date.now();await purgeExpired(db,now);const items=await allQueuedFromDb(db);if(items.length>=QUEUE_MAX_ITEMS){throw new Error('Offline emergency queue is full; reconnect to send pending emergencies before creating another queued report.');}await put(db,{id:idempotencyKey,payload,idempotencyKey,createdAt:now,attempts:0,nextAttemptAt:now});}
export async function flushQueue(){
  if(!backendConfigured || !navigator.onLine || !hasSession()) return {sent:0,remaining:await queueCount(),dead:0};
  const db=await openDb();
  await purgeExpired(db,Date.now());
  const items=await allQueuedFromDb(db);
  let sent=0, dead=0;
  for(const item of items.sort((a,b)=>(a.createdAt||0)-(b.createdAt||0))){
    if(item.state===QUEUE_STATE_DEAD || item.state===QUEUE_STATE_SENT) continue;
    if(item.nextAttemptAt && item.nextAttemptAt>Date.now()) continue;
    // Expired by TTL
    if(item.createdAt && Date.now()-item.createdAt>QUEUE_TTL_MS){
      item.state=QUEUE_STATE_EXPIRED;
      await put(db,item);
      continue;
    }
    try{
      item.state=QUEUE_STATE_RETRYING;
      await put(db,item);
      const incident=await createIncident(item.payload,item.idempotencyKey);
      await removeQueued(item.id);
      localStorage.setItem('reach_last_incident',JSON.stringify({id:incident.id,code:incident.code}));
      if(appState.emergency && appState.emergency.incidentId===item.idempotencyKey){
        appState.emergency.incidentId=incident.id;
        appState.emergency.incidentCode=incident.code;
      }
      await rebindQueuedEvidence(item.idempotencyKey,incident.id);
      sent++;
    }catch(err){
      const attempts=(item.attempts||0)+1;
      item.attempts=attempts;
      item.lastError=String(err&&err.message||err).slice(0,300);
      if(attempts>=QUEUE_MAX_ATTEMPTS){
        item.state=QUEUE_STATE_DEAD;
        item.deadAt=Date.now();
        dead++;
      }else{
        item.state=QUEUE_STATE_RETRYING;
        item.nextAttemptAt=Date.now()+Math.min(120000,1000*Math.pow(2,attempts));
      }
      await put(db,item);
    }
  }
  return {sent,remaining:await queueCount(),dead};
}
function openDb(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DB_NAME,DB_VERSION);req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE,{keyPath:'id'});if(!db.objectStoreNames.contains('sync-meta'))db.createObjectStore('sync-meta',{keyPath:'key'});if(!db.objectStoreNames.contains(RELAY_STORE))db.createObjectStore(RELAY_STORE,{keyPath:'id'});};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
function put(db,value){return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put(value);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
function allQueued(){return openDb().then(async db=>{await purgeExpired(db,Date.now());return allQueuedFromDb(db);});}
function allQueuedFromDb(db){return new Promise((resolve,reject)=>{const req=db.transaction(STORE).objectStore(STORE).getAll();req.onsuccess=()=>resolve(req.result||[]);req.onerror=()=>reject(req.error);});}
function purgeExpired(db,now){return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');const store=tx.objectStore(STORE);const req=store.getAll();req.onsuccess=()=>{for(const item of req.result||[])if(!item.createdAt||now-item.createdAt>QUEUE_TTL_MS)store.delete(item.id);};tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
function markAttempt(db,item){return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');const next={...item,attempts:Number(item.attempts||0)+1,nextAttemptAt:Date.now()+Math.min(5*60*1000,Math.max(5000,2**Math.min(6,Number(item.attempts||0)+1)*1000))};tx.objectStore(STORE).put(next);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
function removeQueued(id){return openDb().then(db=>new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).delete(id);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);}));}
function queueCount(){return allQueued().then(items=>items.length).catch(()=>0);}

/**
 * Rebind evidence captured before the incident existed.
 *
 * A capture taken on the review screen has no incident id yet, so it is queued against the report's
 * idempotency key. Once the report is accepted the key is meaningless, so the capture is moved onto
 * the real incident id and attached. Lazy import keeps this module free of a load-order dependency
 * on evidence.js.
 */
async function rebindQueuedEvidence(reportKey, incidentId) {
  try {
    const { listEvidenceQueue, queueEvidenceCapture } = await import('./evidence.js');
    const rows = await listEvidenceQueue();
    for (const row of rows) {
      if (row.incidentKey !== reportKey || row.incidentId) continue;
      await queueEvidenceCapture({ incidentId, incidentKey: null, kind: row.kind, blob: row.blob, mime: row.mime, meta: row.meta });
      const db = await openDb();
      await new Promise((resolve, reject) => { const tx = db.transaction('evidence-queue', 'readwrite'); tx.objectStore('evidence-queue').delete(row.id); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    }
  } catch { /* evidence stays queued; the next flush retries */ }
}

export function buildIncidentPayload(){const e=appState.emergency;const a=appState.aiDetection;return{
  category:e.category,title:`${e.categoryLabel} emergency`,description:`Citizen-confirmed ${e.categoryLabel.toLowerCase()} emergency from REACH PWA.`,priority:(e.priority||'high').toLowerCase(),source_channel:'pwa',delivery_method:navigator.onLine?'internet':'offline-queue',location_label:e.locationLabel,location_source:e.locationType==='gps'?'gps':e.locationType==='registered'?'registered':'manual',location_accuracy_m:e.locationAccuracyM,latitude:e.latitude,longitude:e.longitude,ai_confidence:Number(a.confidencePct||0),ai_fp_code:a.confidencePct?`FP-${String(e.category).toUpperCase()}-${Math.round(Number(a.confidencePct))}`:null,via_relay:false,location_context:{network:navigator.onLine?'online':'offline',relay_enabled:appState.relayEnabled}
};}

async function tryNativeRelay(payload,key){
  const bridge=window.REACH_NATIVE_RELAY;
  if(!bridge || typeof bridge.sendPacket!=='function' || !appState.relayEnabled) return null;
  const built=await buildRelayPacket({packetKey:key,incidentId:null,category:payload.category,priority:payload.priority,title:payload.title,description:payload.description,locationLabel:payload.location_label,locationSource:payload.location_source,locationAccuracyM:payload.location_accuracy_m,latitude:payload.latitude,longitude:payload.longitude});
  const accepted=await bridge.sendPacket(JSON.stringify(built.packet));
  // The bridge returns {accepted, packet_key, packet_hash} as a JSON string; older builds
  // returned a plain boolean. Anything that is not an explicit rejection counts as accepted.
  let ok=true, ack={};
  if(accepted===false || accepted==='false') ok=false;
  else if(typeof accepted==='string'){
    try{ ack=JSON.parse(accepted); if(ack.accepted===false) ok=false; }catch{ /* non-JSON truthy response */ }
  }
  if(!ok) throw new Error('Native relay did not accept the packet');
  // The node only enqueues here; the packet is delivered only after a verified ACK from a peer or a
  // gateway upload. Say that, rather than implying it has already left the device.
  return {status:'relay-queued',packet:built.packet,packetKey:ack.packet_key,packetHash:ack.packet_hash,
    message:'Saved and handed to the relay node — it will be carried to REACH as soon as a nearby device or a connection is available.'};
}

/**
 * Hand the signed packet to a nearby relay node over Web Bluetooth, when one has already been paired.
 *
 * The pairing chooser needs a user gesture, so this only reuses a connection the citizen established
 * on the relay screen — it never opens a chooser from a send. Delivery is claimed only on the node's
 * verified ACK; otherwise the caller falls through to the queued gateway path.
 */
async function tryDirectRelay(payload,key){
  if(!directRelayAvailable() || !directRelayConnection()) return null;
  const built=await buildRelayPacket({packetKey:key,incidentId:null,category:payload.category,priority:payload.priority,title:payload.title,description:payload.description,locationLabel:payload.location_label,locationSource:payload.location_source,locationAccuracyM:payload.location_accuracy_m,latitude:payload.latitude,longitude:payload.longitude});
  const result=await sendPacketViaDirectRelay(built.packet);
  if(!result.ok) throw new Error(`Direct relay did not confirm delivery (${result.reason})`);
  return {status:'relay-queued',packet:built.packet,packetKey:key,packetHash:built.hash,device:result.device,
    message:`Carried by ${result.device} — it will reach REACH as soon as a connection is available.`};
}

/**
 * Send a signed probe packet through the native relay node and report what actually happened.
 *
 * sendPacket only *enqueues*: the node deletes a packet only after a verified ACK from a peer (or a
 * 2xx gateway upload), so the probe polls the node's queue for the packet's real fate instead of
 * treating "accepted" as "carried". That is the difference between "the radios are on" and "my
 * alert will get through", which is the only question that matters when someone needs help.
 */
export async function probeNativeRelay(){
  const bridge=window.REACH_NATIVE_RELAY;
  if(!bridge || typeof bridge.sendPacket!=='function'){
    // No native node in this app: a plain browser (or a PWABuilder/TWA shell) can still hand a
    // packet to a nearby relay node over Web Bluetooth, so test that path instead of refusing.
    if(directRelayAvailable()) return probeDirectRelay();
    return {ok:false,detail:'No relay radio is available here. Use “Save alert file to transfer” to hand your signed alert to a REACH relay phone over Bluetooth or Wi-Fi file transfer.'};
  }
  const key=`pwa-probe-${crypto.randomUUID()}`;
  const built=await buildRelayPacket({packetKey:key,incidentId:null,category:'test',priority:'low',title:'REACH relay test',description:'Relay link test — no emergency.',locationLabel:'Relay test',locationSource:'manual'});
  const raw=await bridge.sendPacket(JSON.stringify(built.packet));
  let accepted=false;
  if(raw===true||raw==='true') accepted=true;
  else if(typeof raw==='string'){ try{ accepted=JSON.parse(raw)?.accepted===true; }catch{ accepted=false; } }
  else if(raw&&typeof raw==='object'){ accepted=raw.accepted===true; }
  if(!accepted) return {ok:false,detail:'The relay node did not accept the test packet. Keep both devices nearby and try again.'};
  // Without a way to check the packet's fate we can only say it was queued — not that it was carried.
  if(typeof bridge.packetStatus!=='function') return {ok:false,detail:'The relay node queued the test packet but cannot report whether a nearby device carried it.'};
  const deadline=Date.now()+15000;
  let last='pending';
  while(Date.now()<deadline){
    await new Promise(r=>setTimeout(r,700));
    let state;
    try{ state=JSON.parse(bridge.packetStatus(key))?.state; }catch{ state=undefined; }
    if(state==='delivered') return {ok:true,detail:'Another REACH device carried the test packet. Your phone can relay alerts.'};
    if(state==='dead') return {ok:false,detail:'No REACH device could carry the test packet. Keep the app open on both phones and try again.'};
    if(state) last=state;
  }
  return {ok:false,detail:last==='sending'
    ? 'The test packet is still being sent. Keep the app open on both phones and try again.'
    : 'No REACH device carried the test packet yet. Keep the app open on both phones and try again.'};
}

/** Build a signed packet and queue it for the gateway. Returns null when relay is disabled. */
async function queueSignedRelayPacket(payload,key){
  if(!appState.relayEnabled) return null;
  const built=await buildRelayPacket({packetKey:key,incidentId:null,category:payload.category,priority:payload.priority,title:payload.title,description:payload.description,locationLabel:payload.location_label,locationSource:payload.location_source,locationAccuracyM:payload.location_accuracy_m,latitude:payload.latitude,longitude:payload.longitude});
  await queueRelayPacket(built.packet);
  localStorage.setItem('reach_relay_packet_key',key);
  return built.packet;
}

export async function sendOrQueueEmergency(){
  const payload=buildIncidentPayload(); const key=`pwa-${crypto.randomUUID()}`;
  try{
    if(!navigator.onLine){
      try{const relayed=await tryNativeRelay(payload,key); if(relayed){appState.emergency.incidentId=null;appState.emergency.incidentCode=key.slice(-8).toUpperCase();appState.emergency.deliveryMethod='Native relay (queued)';localStorage.setItem('reach_relay_packet_key',key);await bindEvidence({reportKey:key});return relayed;}}catch{}
      // No native bridge: hand the packet to a nearby relay node over Web Bluetooth if one is paired.
      try{const relayed=await tryDirectRelay(payload,key); if(relayed){appState.emergency.incidentId=null;appState.emergency.incidentCode=key.slice(-8).toUpperCase();appState.emergency.deliveryMethod='Nearby relay node';await bindEvidence({reportKey:key});return relayed;}}catch{}
      // No native bridge: queue a signed packet so the gateway can upload it on reconnect.
      try{const queued=await queueSignedRelayPacket(payload,key); if(queued){appState.emergency.incidentId=null;appState.emergency.incidentCode=key.slice(-8).toUpperCase();appState.emergency.deliveryMethod='Relay gateway (queued)';await bindEvidence({reportKey:key});return {status:'relay-queued',packet:queued};}}catch{}
      throw new Error('OFFLINE');
    }
    const incident=await createIncident(payload,key);appState.emergency.incidentId=incident.id;appState.emergency.incidentCode=incident.code||incident.id;appState.emergency.deliveryMethod='Connected gateway';await bindEvidence({incidentId:incident.id});void flushEvidenceQueue();return{status:'sent',incident};
  }catch(error){
    const retryable=!error.status || error.status>=500 || error.status===429;
    if(!retryable) return {status:'failed',error};
    await queueIncident(payload,key);appState.emergency.incidentId=key;appState.emergency.incidentCode=key.slice(-8).toUpperCase();appState.emergency.deliveryMethod=hasSession()?'Waiting for connection':'Saved locally — sign in when connected';await bindEvidence({reportKey:key});return{status:'queued',error};
  }
}

/** Claim any capture taken before the report existed. Never fails the send: an unbound capture
 * simply stays queued and is claimed on a later flush. */
async function bindEvidence(destination){
  try{
    const { bindUnboundEvidence } = await import('./evidence.js');
    await bindUnboundEvidence(destination);
  }catch{ /* capture stays unbound; retried on the next send or flush */ }
}

export async function getContacts(){return (await api('/contacts')).data;}
export async function addContact(contact){return (await api('/contacts',{method:'POST',body:JSON.stringify(contact)})).data;}
export async function deleteContact(id){await api(`/contacts/${encodeURIComponent(id)}`,{method:'DELETE'});}
export async function getRelayCapabilities(){ return detectRelayCapabilities(); }
/** Pair with a nearby relay node over Web Bluetooth. Must be called from a user gesture. */
export async function pairDirectRelay(){ return connectDirectRelay(); }
/** Send a harmless probe to a nearby relay node and report whether it carried the packet. */
export async function testDirectRelay(){ return probeDirectRelay(); }
export function initBackendSync(){
  // A returning launch restores the session from localStorage, so signup/login never runs and the
  // native relay node would never be handed the gateway session — leaving it with no uplink config
  // (and, before, no registered relay identity). Hand the restored session over once on startup.
  try { const restored=getSession(); if(restored?.access_token) syncNativeBridgeSession(restored); } catch {}
  const flush=()=>{void flushQueue();void flushRelayQueue();void flushEvidenceQueue();};window.addEventListener('online',flush);window.setInterval(()=>{if(navigator.onLine)flush();},30000);flush();}

/** Attach captures that already have an incident (or a queued report) to attach to. A row whose
 * emergency report has not been accepted yet is left for rebindQueuedEvidence to repoint. */
async function flushEvidenceQueue(){
  try{
    const { flushEvidenceQueue: flush } = await import('./evidence.js');
    await flush(row => row.incidentId || null);
  }catch{ /* evidence stays queued */ }
}


/** Mark offline queue item dead after max attempts — never silent discard. */
export async function markQueueDead(id, reason) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => {
      const row = req.result;
      if (!row) return resolve(false);
      row.state = QUEUE_STATE_DEAD;
      row.lastError = String(reason || 'max_attempts').slice(0, 300);
      row.deadAt = Date.now();
      tx.objectStore(STORE).put(row);
    };
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

export async function listDeadLetter() {
  const items = await allQueued().catch(() => []);
  return items.filter((i) => i.state === QUEUE_STATE_DEAD || i.state === 'dead_letter');
}


/** Call on app start after login — recovers browser-restart queue safely (idempotent keys). */
export function resumeOfflineQueue(){
  if(typeof window==='undefined') return;
  const run=()=>{ if(navigator.onLine && hasSession()) flushQueue().catch(()=>{}); };
  window.addEventListener('online', run);
  // Deferred resume after sign-in
  setTimeout(run, 1500);
}

// Expose the relay-queue reader for the relay status UI. Importing backend.js from
// relay/status.js would be a cycle (backend -> protocol -> ... ), so status.js reads this handle.
if(typeof window!=='undefined') window.REACH_RELAY_QUEUE={listRelayQueue,listRelayDeadLetter};
