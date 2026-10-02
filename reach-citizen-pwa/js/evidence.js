/**
 * REACH Mobile App - Evidence capture and offline queue
 *
 * Captured media is the strongest evidence the fusion engine accepts, so it is uploaded to the
 * private `incident-evidence` bucket and registered against the incident. The object path must begin
 * with the uploader's own uid — both the storage policy and the server RPC enforce it — so the path
 * is built here as `${userId}/${sha256}.${ext}`.
 *
 * Captures can happen before an incident exists (the citizen photographs the scene on the review
 * screen, then sends). Those are held in IndexedDB and attached once the incident id is known, on
 * the same reconnect timer that flushes the emergency queue. If the incident is still unsent when
 * the capture is attached, it is linked to the queued report's idempotency key instead, and rebound
 * to the real incident id when the queue flushes.
 */

import { sha256Hex, evidenceKindForMime } from './utils.js';

const cfg = window.REACH_CONFIG || {};
const SUPABASE_URL = (cfg.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = cfg.SUPABASE_ANON_KEY || '';
const API_URL = (cfg.API_URL || `${SUPABASE_URL}/functions/v1/api`).replace(/\/$/, '');
const BUCKET = 'incident-evidence';
const SESSION_KEY = 'reach_pwa_session';
const DB_NAME = 'reach-offline';
// Must match backend.js: both modules open `reach-offline`, and IndexedDB rejects a connection
// opened below the existing version. Bumped to 4 to add the evidence-queue store.
const DB_VERSION = 4;
const STORE = 'evidence-queue';

/** Kinds a citizen device may capture. `corroboration` is deliberately absent: it has to mean
 * independent corroboration, not something a client asserts about itself. */
export const CAPTURE_KINDS = ['image', 'audio', 'video'];
export const CAPTURE_ACCEPT = 'image/*,audio/*,video/*';

function getSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; } }
export function hasSession() { return Boolean(getSession()?.access_token); }

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('incident-queue')) db.createObjectStore('incident-queue', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('sync-meta')) db.createObjectStore('sync-meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('relay-queue')) db.createObjectStore('relay-queue', { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) { return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); }

async function allRows() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function putRow(row) {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(row);
  await txDone(tx);
}

async function deleteRow(id) {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).delete(id);
  await txDone(tx);
}

/**
 * Hold a capture in IndexedDB until it can be attached.
 * @param {{incidentId: string|null, incidentKey: string|null, kind: string, blob: Blob, mime: string, meta: object}} capture
 */
export async function queueEvidenceCapture(capture) {
  const id = `ev-${crypto.randomUUID()}`;
  await putRow({
    id,
    incidentId: capture.incidentId || null,
    incidentKey: capture.incidentKey || null,
    kind: capture.kind,
    mime: capture.mime,
    meta: capture.meta || {},
    blob: capture.blob,
    createdAt: Date.now(),
    attempts: 0,
    state: 'pending',
    lastError: null,
  });
  return id;
}

export async function listEvidenceQueue() { return allRows(); }
export async function evidenceQueueCount() { return (await allRows()).length; }

/**
 * Point every capture that has no destination yet at this report.
 *
 * Captures are taken on the review screen, before the citizen chooses a category, location or
 * presses send — so at capture time there is no incident to attach to. They are held unbound and
 * claimed here, at send time, by whichever of the two identifiers the send path produced: a real
 * incident id when the gateway accepted the report, or the report's idempotency key when it was
 * queued for later.
 *
 * @param {{incidentId?: string|null, reportKey?: string|null}} destination
 */
export async function bindUnboundEvidence({ incidentId = null, reportKey = null } = {}) {
  if (!incidentId && !reportKey) return 0;
  let bound = 0;
  for (const row of await allRows()) {
    if (row.incidentId || row.incidentKey) continue;
    await putRow({ ...row, incidentId, incidentKey: reportKey });
    bound++;
  }
  return bound;
}

/**
 * Upload a held capture and register it. Returns the created evidence row.
 * @param {object} row - A row from queueEvidenceCapture
 * @param {string} incidentId - The incident (or queued report key) to attach to
 */
async function uploadAndAttach(row, incidentId) {
  const session = getSession();
  if (!session?.access_token) throw new Error('NO_BACKEND_SESSION');
  if (!session.user?.id) throw new Error('Session is missing a user id');

  const hash = await sha256Hex(row.blob);
  const ext = (String(row.mime).split('/')[1] || 'bin').replace(/[^a-z0-9]/g, '').slice(0, 8);
  const storagePath = `${session.user.id}/${hash}.${ext}`;

  const upload = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': row.mime || 'application/octet-stream',
      'x-upsert': 'true',
    },
    body: row.blob,
  });
  if (!upload.ok) {
    const detail = await upload.json().catch(() => ({}));
    const error = new Error(detail.message || `Upload failed (${upload.status})`);
    error.status = upload.status;
    throw error;
  }

  const res = await fetch(`${API_URL}/evidence`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      incident_id: incidentId,
      kind: row.kind,
      storage_path: storagePath,
      content_hash: hash,
      metadata: { ...row.meta, mime: row.mime || null },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `Attach failed (${res.status})`);
    error.status = res.status;
    throw error;
  }
  return data.data;
}

/**
 * Attach one capture immediately. Falls back to the queue on any failure, so a capture is never
 * lost to a dropped connection.
 * @returns {{status:'attached'|'queued', evidence?:object, error?:Error}}
 */
export async function attachEvidenceNow(incidentId, kind, blob, mime, meta = {}) {
  const row = { kind, mime, meta, blob };
  try {
    const evidence = await uploadAndAttach(row, incidentId);
    return { status: 'attached', evidence };
  } catch (error) {
    await queueEvidenceCapture({ incidentId, incidentKey: null, kind, blob, mime, meta });
    return { status: 'queued', error };
  }
}

/**
 * Upload every held capture that now has a destination.
 *
 * @param {(row:object) => string|null} resolveIncidentId - Maps a queued row to an incident id, or
 *   null to leave it queued (e.g. its emergency report has not been sent yet).
 * @param {(row:object, incidentId:string) => void} [onRebound] - Called after a capture queued
 *   against a report key is attached, so the caller can rebind anything that tracked that key.
 */
export async function flushEvidenceQueue(resolveIncidentId, onRebound) {
  if (!navigator.onLine || !hasSession()) return { sent: 0, remaining: await evidenceQueueCount(), failed: 0 };
  let sent = 0, failed = 0;
  for (const row of (await allRows()).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))) {
    // A rejected row was already refused with a 4xx; retrying it every flush would just log the
    // same failure forever. It stays on disk so the citizen can see it was not attached.
    if (row.state === 'rejected') continue;
    const incidentId = resolveIncidentId(row);
    if (!incidentId) continue;
    try {
      await uploadAndAttach(row, incidentId);
      await deleteRow(row.id);
      sent++;
      if (onRebound && row.incidentKey) onRebound(row, incidentId);
    } catch (error) {
      const attempts = Number(row.attempts || 0) + 1;
      // A 4xx is a permanent rejection (bad kind, foreign path, incident gone); retrying cannot
      // help, so surface it rather than looping forever.
      const permanent = error.status >= 400 && error.status < 500;
      await putRow({ ...row, attempts, lastError: String(error.message || error).slice(0, 300), state: permanent ? 'rejected' : 'pending' });
      failed++;
      if (!permanent) break;
    }
  }
  return { sent, remaining: await evidenceQueueCount(), failed };
}
