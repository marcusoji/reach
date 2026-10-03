/**
 * REACH Mobile App - Main Application Bootstrap
 *
 * Connects state, navigation, and user interactions.
 */

import {
  appState,
  setRelayEnabled,
  setSelectedCategory,
  setSelectedLocation,
  setGpsCoordinates,
  setNetworkAvailable,
  subscribeState
} from './state.js';
import { navigateTo, SCREEN_CONFIG, registerScreenRenderers } from './navigation.js';
import { $, $$, setText, evidenceKindForMime } from './utils.js';

/**
 * Handle Background Relay Switch Toggle
 */
function handleRelayToggle() {
  const isEnabled = setRelayEnabled();
  const toggleRow = $('#relayToggleRow');
  const toggleSwitch = $('#relaySwitch');
  const toggleSub = $('#relayToggleSub');

  if (toggleRow) toggleRow.classList.toggle('on', isEnabled);
  if (toggleSwitch) toggleSwitch.classList.toggle('on', isEnabled);
  if (toggleSub) {
    toggleSub.textContent = isEnabled
      ? 'On — this device can carry emergency packets nearby'
      : 'Off — this device will not relay for others';
  }

  if (backendConfigured && hasSession()) void updateProfile({ relay_enabled: isEnabled }).catch(() => undefined);

  // Update home screen relay chip if present
  const homeRelayChip = $('#homeRelayChip');
  if (homeRelayChip) {
    homeRelayChip.style.display = isEnabled ? 'flex' : 'none';
  }
}

/**
 * Handle Emergency Category Selection
 * @param {Element} rowElement - Selected category row
 */
function handleCategorySelect(rowElement) {
  const categoryKey = rowElement.dataset.category || 'fire';
  const labelEl = rowElement.querySelector('.cat-text b');
  const label = labelEl ? labelEl.textContent.trim() : 'Fire';

  // Update UI selection
  $$('.cat-row').forEach(row => row.classList.remove('selected'));
  rowElement.classList.add('selected');

  // Update State
  setSelectedCategory(categoryKey, label);

  // Update Confirm screen summary
  const confirmCatType = $('#confirmCatType');
  if (confirmCatType) confirmCatType.textContent = label;
}

/**
 * Handle Location Option Selection
 * @param {Element} optionElement - Selected location option
 */
function handleLocationSelect(optionElement) {
  const locType = optionElement.dataset.locType || 'registered';
  const labelEl = optionElement.querySelector('b');
  const label = labelEl ? labelEl.textContent.trim() : 'Zone B';

  // Update UI selection
  $$('.loc-option').forEach(opt => opt.classList.remove('selected'));
  optionElement.classList.add('selected');

  // Update State
  setSelectedLocation(locType, label);

  // Update Confirm screen summary
  const confirmLoc = $('#confirmLocType');
  if (confirmLoc) confirmLoc.textContent = label;
}

/**
 * Bind Global Event Delegation
 */
function setupEventDelegation() {

  // Global [data-nav] clicks inside phone screen
  const phoneScreen = $('#phoneScreen');
  if (phoneScreen) {
    phoneScreen.addEventListener('click', event => {
      const navBtn = event.target.closest('[data-nav]');
      if (navBtn) {
        event.preventDefault();
        const targetScreen = navBtn.getAttribute('data-nav');
        if (targetScreen) {
          navigateTo(targetScreen);
        }
      }
    });
  }

  // Relay toggle button
  const relayRow = $('#relayToggleRow');
  if (relayRow) {
    relayRow.addEventListener('click', handleRelayToggle);
  }

  // Relay permission request (Bluetooth/Wi-Fi) from a user gesture.
  const relayEnableButton = $('#relayEnableButton');
  if (relayEnableButton) {
    relayEnableButton.addEventListener('click', () => { void handleRelayPermissionRequest(); });
  }

  // Category selection rows
  const catList = $('#catList');
  if (catList) {
    catList.addEventListener('click', event => {
      const row = event.target.closest('.cat-row');
      if (row) {
        handleCategorySelect(row);
      }
    });
  }

  // Location selection options
  const locList = $('#locList');
  if (locList) {
    locList.addEventListener('click', event => {
      const opt = event.target.closest('.loc-option');
      if (opt) {
        handleLocationSelect(opt);
      }
    });
  }
}

/**
 * Initialize Application
 */
function syncNetworkUi(state = appState) {
  const online = typeof navigator !== 'undefined' ? navigator.onLine : state.emergency.networkAvailable;
  const confirmNetwork = $('#confirmNetwork'); if (confirmNetwork) confirmNetwork.textContent = online ? 'Connected' : 'Offline — local queue / relay path';
  const signal = $('#signalTag'); if (signal && appState.currentScreen === 'confirm') { signal.className = online ? 'signal-tag yes' : 'signal-tag no'; signal.textContent = online ? '4G' : 'NO SIGNAL'; }
}

function init() {
  setupEventDelegation();

  // Subscribe to state changes if needed for global sync
  subscribeState(state => { syncNetworkUi(state); syncProfileIntoHome(); });

  // Start on the splash screen
  navigateTo('splash');
}

// Bootstrap when DOM is fully loaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Backend + offline-first enhancements
import { signup, login, sendOrQueueEmergency, initBackendSync, updateProfile, getIncident, getIncidentHistory, getContacts, addContact, deleteContact, backendConfigured, hasSession } from './backend.js';
import { relayPermissionStatus, requestRelayPermissions } from './relay/permissions.js';
import { relayStatus, relaySummary } from './relay/status.js';

/** Show what relay capability this device actually has, without claiming a radio is on. */
async function refreshRelayPermissionUi() {
  const statusEl = $('#relayPermissionStatus');
  const button = $('#relayEnableButton');
  if (!statusEl && !button) return;
  const status = await relayPermissionStatus();
  if (statusEl) {
    if (status.nativeRelay) {
      statusEl.textContent = 'Relay node detected — Bluetooth and Wi-Fi can be switched on for you.';
    } else if (status.bluetoothApi) {
      statusEl.textContent = status.bluetoothAvailable === false
        ? 'This device reports Bluetooth is switched off. Turn it on, then grant access.'
        : 'Tap to grant Bluetooth access. Wi-Fi stays on for your normal connection.';
    } else {
      statusEl.textContent = 'This browser cannot switch the radios on. Your emergency still reaches REACH over the network or through the offline queue.';
    }
  }
  if (button) {
    button.textContent = status.nativeRelay ? 'Turn on Bluetooth & Wi-Fi' : 'Allow Bluetooth access';
  }
}

/** Request the relay radios from a user gesture and report the honest outcome. */
async function handleRelayPermissionRequest() {
  const statusEl = $('#relayPermissionStatus');
  const button = $('#relayEnableButton');
  if (button) button.disabled = true;
  if (statusEl) statusEl.textContent = 'Waiting for permission…';
  try {
    const result = await requestRelayPermissions();
    if (statusEl) {
      statusEl.textContent = result.granted
        ? (result.detail || 'Relay radios are ready.')
        : (result.detail || 'Relay permission was not granted. Your alert still reaches REACH.');
    }
    if (result.granted) {
      setRelayEnabled(true);
      const toggleRow = $('#relayToggleRow'); const toggleSwitch = $('#relaySwitch');
      if (toggleRow) toggleRow.classList.add('on');
      if (toggleSwitch) toggleSwitch.classList.add('on');
      const sub = $('#relayToggleSub'); if (sub) sub.textContent = 'On — this device can carry emergency packets nearby';
    }
  } catch (error) {
    if (statusEl) statusEl.textContent = error.message || 'Could not request relay permission.';
  } finally {
    if (button) button.disabled = false;
  }
}

/** Entering the relay screen: show real capability and ask the radios to be turned on.
 *
 * The request runs inside the click gesture that got us here, so a browser that requires a user
 * gesture for Web Bluetooth still accepts it. A refusal is reported, never swallowed, and the
 * Continue button is never blocked by it.
 */
async function enterRelayPermissionScreen() {
  await refreshRelayPermissionUi();
  const status = await relayPermissionStatus();
  if (status.nativeRelay || status.bluetoothApi) {
    try { await handleRelayPermissionRequest(); } catch { /* status text already reflects the outcome */ }
  }
}

let registrationInFlight = false;
async function handleCitizenRegistration() {
  const name = $('#registerName')?.value?.trim() || '';
  const email = $('#registerEmail')?.value?.trim().toLowerCase() || '';
  const password = $('#registerPassword')?.value || '';
  const phone = $('#registerPhone')?.value?.trim() || '';
  const location = $('#registerLocation')?.value || '';
  if (!name) { alert('Enter your full name.'); return false; }
  if (backendConfigured && (!email || password.length < 8)) { alert('Enter a valid email and a password of at least 8 characters.'); return false; }
  // A double tap on "Create account" used to fire two signups: the first succeeded, the second
  // returned "user already registered", so the citizen saw a failure for an account that existed.
  if (registrationInFlight) return false;
  registrationInFlight = true;
  appState.user.name = name; appState.user.phone = phone; appState.user.registeredLocation = location;
  if (!backendConfigured) { localStorage.setItem('reach_pwa_profile', JSON.stringify(appState.user)); registrationInFlight = false; return true; }
  try {
    const result = await signup({ email, password, fullName:name, phone });
    localStorage.setItem('reach_pwa_profile', JSON.stringify(appState.user));
    if (!result.access_token) { alert('Account created. Check your email, then use Sign in to continue.'); navigateTo('login'); return false; }
    // The account and session already exist; syncing the extra profile fields is best-effort.
    // A failure here must never read as "account creation failed" — that is what produced the
    // confusing "Failed to fetch ... then user exists" sequence.
    try { await updateProfile({ full_name:name, phone, relay_enabled:appState.relayEnabled }); }
    catch { /* profile sync retried by initBackendSync on the next connection */ }
    return true;
  } catch (error) { alert(error.message || 'Account creation failed.'); return false; }
  finally { registrationInFlight = false; }
}

async function handleCitizenLogin() {
  const email = $('#loginEmail')?.value?.trim().toLowerCase() || '';
  const password = $('#loginPassword')?.value || '';
  if (!email || !password) { alert('Enter your email and password.'); return; }
  try { await login({email,password}); await flushCitizenQueue(); navigateTo('relaypermission'); } catch (error) { alert(error.message || 'Unable to sign in.'); }
}

async function flushCitizenQueue() {
  const { flushQueue } = await import('./backend.js');
  await flushQueue();
}

function requestGpsLocation() {
  if (!navigator.geolocation) { alert('GPS is not available on this device.'); return; }
  navigator.geolocation.getCurrentPosition(
    position => { setGpsCoordinates(position.coords.latitude, position.coords.longitude, position.coords.accuracy); const text = document.querySelector('#locList [data-loc-type="gps"] span'); if (text) text.textContent = `Current location · ±${Math.round(position.coords.accuracy)}m`; },
    () => { const text = document.querySelector('#locList [data-loc-type="gps"] span'); if (text) text.textContent = 'Unable to read GPS — choose another option'; },
    { enableHighAccuracy:true, timeout:8000, maximumAge:30000 }
  );
}

async function renderContacts() {
  const list = $('#contactsList'); if (!list) return;
  if (!backendConfigured || !hasSession()) { list.innerHTML = '<div class="contact-row"><div class="contact-avatar">—</div><div><div class="contact-name">Sign in to manage contacts</div><div class="contact-rel">Trusted contacts are stored securely with your REACH account.</div></div></div>'; return; }
  try {
    const contacts = await getContacts();
    list.innerHTML = contacts.length ? contacts.map(c => `<div class="contact-row" data-contact-id="${c.id}"><div class="contact-avatar">${c.name.split(/\s+/).map(x=>x[0]).join('').slice(0,2).toUpperCase()}</div><div><div class="contact-name">${escapeHtml(c.name)}</div><div class="contact-rel">${escapeHtml(c.relationship || 'Trusted contact')} · ${escapeHtml(c.phone)}</div></div><button class="btn-text contact-delete" data-contact-delete="${c.id}">Remove</button></div>`).join('') : '<div class="contact-row"><div class="contact-avatar">+</div><div><div class="contact-name">No trusted contacts yet</div><div class="contact-rel">Add one so REACH can notify them.</div></div></div>';
  } catch { list.innerHTML = '<div class="contact-row"><div><div class="contact-name">Contacts unavailable</div><div class="contact-rel">Check your connection and try again.</div></div></div>'; }
}
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[c])); }

const HISTORY_STATUS_LABEL = {
  reported: 'Reported', received: 'Received by REACH', verifying: 'Verifying', verified: 'Verified',
  assigned: 'Responder assigned', responding: 'Responders on the way', on_scene: 'On scene',
  resolved: 'Resolved', closed: 'Closed', cancelled: 'Cancelled',
};

function historyStatusLabel(status) { return HISTORY_STATUS_LABEL[status] || String(status || 'Reported').replace(/_/g, ' '); }

function formatHistoryDate(value) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Render the citizen's own incident history. Never fabricates rows: with no session and no
 * cached history it says so, and it shows the last known list when offline. */
async function renderIncidentHistory() {
  const list = $('#historyList');
  const status = $('#historyStatus');
  if (!list) return;
  list.innerHTML = '<div class="contact-row"><div><div class="contact-name">Loading your history…</div></div></div>';
  if (!backendConfigured || !hasSession()) {
    if (status) status.textContent = 'Sign in to see your incident history.';
    list.innerHTML = '<div class="contact-row"><div class="contact-avatar">—</div><div><div class="contact-name">Sign in required</div><div class="contact-rel">Your past reports are tied to your REACH account.</div></div></div>';
    return;
  }
  let rows = [];
  let offline = false;
  try { rows = await getIncidentHistory(); } catch { rows = await getIncidentHistory({ refresh: false }); offline = true; }
  if (!navigator.onLine) offline = true;
  if (status) status.textContent = offline
    ? 'Showing your last known history — reconnect to refresh.'
    : 'Your past emergency reports and their outcomes.';
  if (!rows.length) {
    list.innerHTML = '<div class="contact-row"><div class="contact-avatar">+</div><div><div class="contact-name">No incidents yet</div><div class="contact-rel">Emergencies you report will appear here.</div></div></div>';
    return;
  }
  list.replaceChildren();
  for (const incident of rows) {
    const row = document.createElement('div');
    row.className = 'contact-row';
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.dataset.historyId = incident.id;
    const avatar = document.createElement('div');
    avatar.className = 'contact-avatar';
    avatar.textContent = String(incident.category || '?').slice(0, 1).toUpperCase();
    const body = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'contact-name';
    name.textContent = `${incident.code || 'Incident'} · ${historyStatusLabel(incident.status)}`;
    const detail = document.createElement('div');
    detail.className = 'contact-rel';
    detail.textContent = `${formatHistoryDate(incident.reported_at || incident.created_at)} · ${incident.location_label || 'Location pending'}${incident.via_relay ? ' · via relay' : ''}`;
    body.append(name, detail);
    row.append(avatar, body);
    list.appendChild(row);
  }
}

/** Show one incident from the local history cache. */
function openHistoryDetail(id) {
  const cached = (() => { try { return JSON.parse(localStorage.getItem('reach_incident_history') || '[]'); } catch { return []; } })();
  const incident = cached.find((r) => r.id === id);
  const title = $('#historyDetailTitle');
  const box = $('#historyDetailBox');
  if (!incident || !box) return;
  if (title) title.textContent = incident.code || 'Incident';
  const row = (label, value) => {
    const div = document.createElement('div');
    div.className = 'summary-row';
    const l = document.createElement('span'); l.textContent = label;
    const v = document.createElement('span'); v.textContent = value;
    div.append(l, v);
    return div;
  };
  box.replaceChildren(
    row('Type', String(incident.category || 'unknown')),
    row('Status', historyStatusLabel(incident.status)),
    row('Priority', String(incident.priority || 'high')),
    row('Reported', formatHistoryDate(incident.reported_at || incident.created_at)),
    row('Location', incident.location_label || 'Location pending'),
    row('Delivery', incident.delivery_method || (incident.via_relay ? 'Relay path' : 'Connected gateway')),
  );
}

async function trackActiveIncident() {
  const stored = (()=>{try{return JSON.parse(localStorage.getItem('reach_last_incident')||'null')}catch{return null}})();
  const id = appState.emergency.incidentId || stored?.id; if (!id || !backendConfigured || !hasSession()) return;
  try {
    const incident = await getIncident(id);
    const title = document.querySelector('#screen-tracking .status-hero h2');
    const sub = document.querySelector('#screen-tracking .status-hero p');
    const normalized = incident.status;
    if (title) title.textContent = normalized === 'resolved' || normalized === 'closed' ? 'Emergency resolved' : `Alert ${normalized.replace('_',' ')}`;
    if (sub) sub.textContent = `Incident ${incident.code} · ${incident.location_label || 'Location pending'}`;
    const delivery = document.querySelector('#trackingDeliveryPath'); if (delivery) delivery.textContent = incident.delivery_method || (incident.via_relay ? 'Relay path' : 'Connected gateway');
    const network = document.querySelector('#trackingNetworkState'); if (network) network.textContent = ['received','verifying','verified','assigned','responding','on_scene','resolved','closed'].includes(normalized) ? 'Connected to REACH core' : 'Waiting for sync';
    const core = document.querySelector('#trackingCoreState'); if (core) core.textContent = ['received','verifying','verified','assigned','responding','on_scene','resolved','closed'].includes(normalized) ? 'Received' : 'Pending';
    const responder = document.querySelector('#trackingResponderState'); if (responder) responder.textContent = ['assigned','responding','on_scene','resolved','closed'].includes(normalized) ? 'Assigned' : 'Pending';
  } catch { /* offline or not yet synchronized */ }
}

function syncProfileIntoHome() {
  const greeting = document.querySelector('.greeting b');
  if (greeting) greeting.textContent = (appState.user.name || 'Citizen').split(' ')[0];
}

// --- Evidence capture on the review screen -------------------------------------------------
// Captures are taken before the citizen chooses a category or location, so there is no incident to
// attach to yet. They are held on the device and claimed at send time (see backend.js bindEvidence).

const EVIDENCE_KIND_LABEL = { image: 'Photo', audio: 'Audio', video: 'Video' };

async function captureEvidence(kind, file) {
  const status = $('#captureStatus');
  if (!file) return;
  const mime = file.type || '';
  if (evidenceKindForMime(mime) !== kind) {
    if (status) status.textContent = `That file is not ${EVIDENCE_KIND_LABEL[kind].toLowerCase()} media.`;
    return;
  }
  try {
    const { queueEvidenceCapture } = await import('./evidence.js');
    await queueEvidenceCapture({ incidentId: null, incidentKey: null, kind, blob: file, mime, meta: { name: file.name, size: file.size } });
    await renderCaptureList();
    if (status) status.textContent = `${EVIDENCE_KIND_LABEL[kind]} attached — held on this device until you send.`;
  } catch (error) {
    if (status) status.textContent = `Could not attach that capture: ${error.message || error}`;
  }
}

async function renderCaptureList() {
  const list = $('#captureList');
  if (!list) return;
  let rows = [];
  try {
    const { listEvidenceQueue } = await import('./evidence.js');
    rows = await listEvidenceQueue();
  } catch { rows = []; }
  const check = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>';
  // The file name comes from the citizen's own device but is still untrusted text, so it is set as
  // a text node rather than interpolated into markup.
  list.replaceChildren();
  list.insertAdjacentHTML('beforeend', `<div class="evidence-mini-row">${check}<div><b>You confirmed it</b><span>Human sign-off recorded</span></div></div>`);
  for (const item of rows) {
    const row = document.createElement('div');
    row.className = 'evidence-mini-row';
    row.insertAdjacentHTML('beforeend', check);
    const body = document.createElement('div');
    const title = document.createElement('b');
    title.textContent = `${EVIDENCE_KIND_LABEL[item.kind] || item.kind} attached`;
    const detail = document.createElement('span');
    const name = item.meta?.name ? ` · ${item.meta.name}` : '';
    detail.textContent = `${item.mime || 'media'}${name} · held on this device`;
    body.append(title, detail);
    row.appendChild(body);
    list.appendChild(row);
  }
}

function setupCaptureControls() {
  const open = (inputId) => $(inputId)?.click();
  $('#capturePhotoBtn')?.addEventListener('click', () => open('#captureCamera'));
  $('#captureAudioBtn')?.addEventListener('click', () => open('#captureAudio'));
  $('#captureGalleryBtn')?.addEventListener('click', () => open('#captureGallery'));
  $('#captureCamera')?.addEventListener('change', (e) => { const f = e.target.files?.[0]; e.target.value = ''; void captureEvidence('image', f); });
  $('#captureAudio')?.addEventListener('change', (e) => { const f = e.target.files?.[0]; e.target.value = ''; void captureEvidence('audio', f); });
  $('#captureGallery')?.addEventListener('change', (e) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    const kind = evidenceKindForMime(f.type);
    if (!kind) { const status = $('#captureStatus'); if (status) status.textContent = 'Only photo, audio or video files can be attached as evidence.'; return; }
    void captureEvidence(kind, f);
  });
  void renderCaptureList();
}

setupCaptureControls();

document.addEventListener('click', event => {
  const target = event.target.closest('[data-loc-type="gps"]');
  if (target) requestGpsLocation();
  const loginButton = event.target.closest('#loginSubmit');
  if (loginButton) { event.preventDefault(); void handleCitizenLogin(); }
  const addButton = event.target.closest('#addContactButton');
  if (addButton) {
    event.preventDefault();
    if (!hasSession()) { alert('Sign in first to add a trusted contact.'); return; }
    const name = prompt('Contact name'); const phone = prompt('Phone number'); const relationship = prompt('Relationship (optional)') || '';
    if (name && phone) void addContact({name,phone,relationship}).then(renderContacts).catch(error=>alert(error.message || 'Unable to add contact'));
  }
  const removeButton = event.target.closest('[data-contact-delete]');
  if (removeButton) { const id=removeButton.getAttribute('data-contact-delete'); if(id) void deleteContact(id).then(renderContacts).catch(error=>alert(error.message || 'Unable to remove contact')); }
  const historyRow = event.target.closest('[data-history-id]');
  if (historyRow) { openHistoryDetail(historyRow.getAttribute('data-history-id')); navigateTo('historydetail'); }
});
window.addEventListener('online', () => { setNetworkAvailable(true); });
window.addEventListener('offline', () => { setNetworkAvailable(false); });

const originalSetup = setupEventDelegation;

/** The relay notification screen reflects the real queue, not a scripted "relaying" claim. */
async function renderRelayNotify() {
  const text = $('#relayNotifyText');
  if (!text) return;
  try {
    const status = await relayStatus();
    text.textContent = relaySummary(status);
  } catch {
    text.textContent = 'Relaying an emergency alert nearby. Tap to see what is being sent.';
  }
}

/** Keep the home relay chip honest: show what the node is actually doing right now. */
async function refreshRelayProgress() {
  const progress = $('#homeRelayProgress');
  if (!progress) return;
  if (!appState.relayEnabled) { progress.textContent = ''; return; }
  try {
    const status = await relayStatus();
    progress.textContent = relaySummary(status);
  } catch { progress.textContent = ''; }
}

/**
 * On app open, ask the node to switch its radios on: Bluetooth first, then Wi-Fi.
 *
 * Only the native relay node can do this on launch — it owns the runtime permission dialog and the
 * radio prompts. A plain browser cannot turn either radio on programmatically, and Web Bluetooth
 * only opens its chooser from a real user gesture, so there we leave the request to the relay
 * screen rather than firing an ungestured chooser on open. Nothing here claims a radio is on when
 * the platform refused.
 */
async function requestRadiosOnOpen() {
  try {
    const status = await relayPermissionStatus();
    if (status.nativeRelay) await requestRelayPermissions();
  } catch { /* best effort; the relay screen re-requests with explicit feedback */ }
  void refreshRelayProgress();
}

// Extend the existing delegated interactions without changing the visual structure.
const originalInit = init;

async function enhancedNavHandler(event) {
  const navBtn = event.target.closest('[data-nav]');
  if (!navBtn) return;
  const target = navBtn.getAttribute('data-nav');
  if (target === 'relaypermission') {
    if (appState.currentScreen === 'register') {
      event.preventDefault();
      event.stopImmediatePropagation();
      const ok = await handleCitizenRegistration();
      if (ok) { navigateTo(target); void enterRelayPermissionScreen(); }
      return true;
    }
    // Reached from home/settings: refresh capability detail for this entry.
    setTimeout(() => { void enterRelayPermissionScreen(); }, 0);
  }
  if (target === 'contacts') { void renderContacts(); }
  if (target === 'relaynotify') { void renderRelayNotify(); }
  if (target === 'confirm') { void renderCaptureList(); }
  if (target === 'tracking' && appState.currentScreen === 'confirm') {
    event.preventDefault();
    event.stopImmediatePropagation();
    const result = await sendOrQueueEmergency();
    const tracking = document.querySelector('#screen-tracking');
    const title = tracking?.querySelector('h2');
    const sub = tracking?.querySelector('.status-hero p');
    if (result.status === 'failed') { alert(result.error?.message || 'REACH could not accept the emergency. Review the details and try again.'); return true; }
    if (result.status === 'sent') {
      if (title) title.textContent = 'Alert received by REACH';
      if (sub) sub.textContent = 'Your incident is now in the response network.';
    } else if (result.status === 'queued') {
      if (title) title.textContent = 'Relaying your alert';
      if (sub) sub.textContent = 'Saved safely. It will sync when a connection or relay path is available.';
    }
    navigateTo(target);
    void trackActiveIncident();
    return true;
  }
  return false;
}

// Capture phase ensures the enhanced actions run before the generic navigation handler.
document.addEventListener('click', (event) => { void enhancedNavHandler(event); }, true);

const savedProfile = (() => { try { return JSON.parse(localStorage.getItem('reach_pwa_profile') || 'null'); } catch { return null; } })();
if (savedProfile) Object.assign(appState.user, savedProfile);
registerScreenRenderers({ history: renderIncidentHistory, relayProgress: refreshRelayProgress });
initBackendSync();
syncProfileIntoHome();
syncNetworkUi();
void requestRadiosOnOpen();
window.setInterval(() => { if (appState.currentScreen === 'home') void refreshRelayProgress(); }, 15000);
const demoResolve = $('#demoResolveButton');
const demoRelay = $('#demoRelayButton');
if (backendConfigured) { if (demoResolve) demoResolve.style.display = 'none'; if (demoRelay) demoRelay.style.display = 'none'; }
if (backendConfigured) { setNetworkAvailable(navigator.onLine); }
window.setInterval(() => { if (appState.currentScreen === 'tracking') void trackActiveIncident(); }, 10000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => undefined);
