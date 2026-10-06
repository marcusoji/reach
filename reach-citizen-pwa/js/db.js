/**
 * REACH Mobile App - offline IndexedDB (single schema owner)
 *
 * Every module that needs the offline queues goes through `openReachDb()`. IndexedDB only runs an
 * upgrade when a connection is opened at a *higher* version than the stored one, so if two modules
 * opened `reach-offline` at the same version and only one of them created its store in
 * `onupgradeneeded`, whichever opened first would win and the other store would never exist. That
 * is exactly what happened: backend.js opened first and created incident-queue/sync-meta/relay-queue,
 * evidence.js opened next at the same version, no upgrade fired, and `transaction('evidence-queue')`
 * threw "One of the specified object stores was not found" — so no photo could be attached.
 *
 * Keeping the version and the store list in one place makes that drift impossible. The version was
 * bumped to 5 so a device already stuck at 4 (evidence-queue missing) upgrades and gains the store.
 */
const DB_NAME = 'reach-offline';
export const DB_VERSION = 5;
export const INCIDENT_STORE = 'incident-queue';
export const SYNC_META_STORE = 'sync-meta';
export const RELAY_STORE = 'relay-queue';
export const EVIDENCE_STORE = 'evidence-queue';

/** Every object store, with its key path. The upgrade creates any that are missing. */
const STORES = [
  [INCIDENT_STORE, { keyPath: 'id' }],
  [SYNC_META_STORE, { keyPath: 'key' }],
  [RELAY_STORE, { keyPath: 'id' }],
  [EVIDENCE_STORE, { keyPath: 'id' }],
];

export function openReachDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, options] of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, options);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // A newer tab/window may open the database at a higher version; close so its upgrade is not
      // blocked (an unclosed connection makes the other side wait on `blocked`).
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}
