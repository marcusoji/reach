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
  const title = optionElement.querySelector('b')?.textContent.trim() || 'Zone B';
  const zoneText = optionElement.querySelector('span')?.textContent.trim() || '';
  // The registered row names the real zone in its subtitle ("Zone B — Hostel Block 4"); use that as
  // the label so the report carries the zone the citizen picked, not the generic row title.
  const label = locType === 'gps' ? 'Current GPS location'
    : locType === 'manual' ? 'Manual zone'
    : (zoneText || title);

  // Update UI selection
  $$('.loc-option').forEach(opt => opt.classList.remove('selected'));
  optionElement.classList.add('selected');

  // Update State
  setSelectedLocation(locType, label);

  // Update Confirm screen summary
  const confirmLoc = $('#confirmLocType');
  if (confirmLoc) confirmLoc.textContent = confirmLocationText();
}

/** What the Review screen shows for location: the actual fix when there is one, else the label. */
function confirmLocationText() {
  const e = appState.emergency;
  if (e.locationType === 'gps' && e.latitude != null && e.longitude != null) {
    const acc = e.locationAccuracyM != null ? ` ±${Math.round(e.locationAccuracyM)}m` : '';
    return `${e.latitude.toFixed(5)}, ${e.longitude.toFixed(5)}${acc}`;
  }
  return e.locationLabel || 'Zone B';
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
  const relayTestButton = $('#relayTestButton');
  if (relayTestButton) {
    relayTestButton.addEventListener('click', () => { void handleRelayLinkTest(); });
  }
  const relayExportButton = $('#relayExportButton');
  if (relayExportButton) {
    relayExportButton.addEventListener('click', () => { void handleRelayExport(); });
  }
  const relayImportButton = $('#relayImportButton');
  const relayImportInput = $('#relayImportInput');
  if (relayImportButton && relayImportInput) {
    relayImportButton.addEventListener('click', () => relayImportInput.click());
    relayImportInput.addEventListener('change', () => { void handleRelayImport(relayImportInput); });
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
  subscribeState(state => { syncNetworkUi(state); syncProfileIntoHome(); syncLocationScreen(); });

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
import { signup, login, sendOrQueueEmergency, initBackendSync, updateProfile, getProfile, joinInstitution, exportRelayPackets, importRelayPackets, flushRelayQueue, getIncident, getIncidentHistory, getContacts, addContact, deleteContact, backendConfigured, hasSession, probeNativeRelay, pairDirectRelay } from './backend.js';
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
      const radio = status.native;
      if (!radio?.permissions) {
        statusEl.textContent = 'Relay node ready — tap below to turn on Bluetooth and Wi-Fi.';
      } else if (radio?.advertising) {
        statusEl.textContent = 'Waiting to carry emergency packets nearby. Use “Test relay link” to confirm a packet can be carried.';
      } else {
        statusEl.textContent = 'Relay node has permission but is not carrying packets yet — switch Bluetooth on, then reopen REACH.';
      }
    } else if (status.directRelay) {
      statusEl.textContent = status.bluetoothAvailable === false
        ? 'This device reports Bluetooth is switched off. Turn it on, then pair with a nearby relay node.'
        : 'Pair with a nearby REACH relay phone to hand it your alert when there is no internet.';
    } else if (status.bluetoothApi) {
      statusEl.textContent = status.bluetoothAvailable === false
        ? 'This device reports Bluetooth is switched off. Turn it on, then grant access.'
        : 'Tap to turn on Bluetooth and relay to nearby REACH devices.';
    } else {
      statusEl.textContent = 'Tap to turn on relay. Your emergency is carried to REACH through the nearby relay network.';
    }
  }
  if (button) {
    button.textContent = status.nativeRelay ? 'Turn on Bluetooth & Wi-Fi' : (status.directRelay ? 'Pair with a nearby relay node' : 'Turn on Bluetooth & Wi-Fi');
  }
}

/** Request the relay radios from a user gesture and report the honest outcome. */
async function handleRelayPermissionRequest() {
  const statusEl = $('#relayPermissionStatus');
  const button = $('#relayEnableButton');
  if (button) button.disabled = true;
  if (statusEl) statusEl.textContent = 'Waiting for permission…';
  try {
    const capability = await relayPermissionStatus();
    // In a plain browser the only relay radio is Web Bluetooth, and pairing a REACH relay node is
    // what grants it. Pairing through the relay module keeps the connection for later sends instead
    // of opening a throwaway chooser.
    if (capability.directRelay) {
      const connection = await pairDirectRelay();
      const name = connection?.device?.name || 'nearby REACH device';
      if (statusEl) statusEl.textContent = `Paired with ${name}. Use “Test relay link” to confirm a packet can be carried.`;
      setRelayEnabled(true);
      const toggleRow = $('#relayToggleRow'); const toggleSwitch = $('#relaySwitch');
      if (toggleRow) toggleRow.classList.add('on');
      if (toggleSwitch) toggleSwitch.classList.add('on');
      const sub = $('#relayToggleSub'); if (sub) sub.textContent = `On — paired with ${name} to carry emergency packets`;
      return;
    }
    const result = await requestRelayPermissions();
    if (statusEl) {
      statusEl.textContent = result.granted
        ? (result.detail || 'Relay radios are ready.')
        : (result.detail || 'This device cannot relay on its own. Your alert is sent when you have a connection, or save the alert file to hand to a relay phone.');
    }
    if (result.granted) {
      setRelayEnabled(true);
      const toggleRow = $('#relayToggleRow'); const toggleSwitch = $('#relaySwitch');
      if (toggleRow) toggleRow.classList.add('on');
      if (toggleSwitch) toggleSwitch.classList.add('on');
      const sub = $('#relayToggleSub'); if (sub) sub.textContent = 'On — this device carries emergency packets to nearby REACH devices';
    }
  } catch (error) {
    const message = String(error?.message || '');
    if (statusEl) statusEl.textContent = /cancel|user/i.test(message) ? 'No relay device was selected.' : (message || 'Could not request relay permission.');
  } finally {
    if (button) button.disabled = false;
  }
}

/**
 * Prove the relay link end to end, not just that the radios are on.
 *
 * A granted permission says nothing about whether a packet can actually be carried, so this sends a
 * real (harmless, signed) probe packet and reports whether another REACH device accepted it. That is
 * the difference between "Bluetooth is enabled" and "my alert will get through".
 */
async function handleRelayLinkTest() {
  const statusEl = $('#relayPermissionStatus');
  const button = $('#relayTestButton');
  if (button) button.disabled = true;
  if (statusEl) statusEl.textContent = 'Looking for another REACH device nearby…';
  try {
    const result = await probeNativeRelay();
    if (statusEl) statusEl.textContent = result.detail;
  } catch (error) {
    if (statusEl) statusEl.textContent = error.message || 'The relay test could not run.';
  } finally {
    if (button) button.disabled = false;
  }
}

/**
 * Save the signed relay packets as a file the citizen can transfer by hand.
 *
 * This is the answer to "there is no relay node on this device": the packets are already
 * source-signed, so the citizen can share the JSON over any channel the phone has (Bluetooth file
 * transfer, a Wi-Fi Direct share, a USB cable, a nearby laptop) and a REACH relay node uploads them
 * unchanged. The native share sheet is preferred; a plain download is the fallback.
 */
async function handleRelayExport() {
  const statusEl = $('#relayExportStatus');
  const button = $('#relayExportButton');
  if (button) button.disabled = true;
  if (statusEl) statusEl.textContent = 'Collecting your saved alerts…';
  try {
    const payload = await exportRelayPackets();
    if (!payload.packets.length) {
      if (statusEl) statusEl.textContent = 'No saved alerts to transfer yet. A report you send while offline is kept here.';
      return;
    }
    const name = `reach-alert-${new Date().toISOString().slice(0,10)}.json`;
    const text = JSON.stringify(payload, null, 2);
    // Inside the native relay-node app the WebView has no share sheet and cannot complete a blob
    // download, so the file is written natively into Downloads. In a plain browser the share sheet
    // is preferred (it can hand the file straight to a Bluetooth/Wi-Fi transfer app), with a plain
    // download as the fallback.
    const native = window.REACH_NATIVE_RELAY;
    if (native && typeof native.saveExportFile === 'function') {
      const raw = native.saveExportFile(name, text);
      let result = {};
      try { result = JSON.parse(raw || '{}'); } catch { /* treat as unsaved */ }
      if (statusEl) {
        statusEl.textContent = result.saved
          ? `Saved ${payload.packets.length} alert packet${payload.packets.length === 1 ? '' : 's'} to ${result.location || 'Downloads'}. Open your file manager to send it to a REACH relay phone.`
          : 'The alert file could not be saved on this device.';
      }
      return;
    }
    const file = new File([text], name, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'REACH alert packet', text: 'Signed REACH relay packets — hand these to a relay node.' });
      if (statusEl) statusEl.textContent = `Shared ${payload.packets.length} alert packet${payload.packets.length === 1 ? '' : 's'}.`;
    } else {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      if (statusEl) statusEl.textContent = `Saved ${payload.packets.length} alert packet${payload.packets.length === 1 ? '' : 's'}. Transfer the file to a REACH relay phone.`;
    }
  } catch (error) {
    // A cancelled share sheet is not a failure worth an error line.
    if (statusEl) statusEl.textContent = /cancel|abort/i.test(String(error?.name || error?.message || '')) ? '' : (error?.message || 'Could not prepare the alert file.');
  } finally {
    if (button) button.disabled = false;
  }
}

/**
 * Receive a REACH alert file that someone transferred to this device and queue it for upload.
 *
 * The receiving half of "Save alert file to transfer": a citizen hands their signed packet file to
 * this device (Bluetooth/Wi-Fi file transfer, USB, a nearby laptop) and it joins this device's relay
 * queue, so it uploads to the gateway on the next connection — no radio peer required.
 */
async function handleRelayImport(input) {
  const statusEl = $('#relayImportStatus');
  const file = input?.files?.[0];
  if (input) input.value = '';
  if (!file) return;
  if (statusEl) statusEl.textContent = 'Reading the alert file…';
  try {
    const text = await file.text();
    const result = await importRelayPackets(JSON.parse(text));
    // Try to move the packets right away: the gateway when online, or this device's relay radios
    // when offline, rather than waiting for the next sync tick.
    if (result.accepted) { try { await flushRelayQueue(); } catch { /* stays queued for the next sync */ } }
    if (statusEl) {
      statusEl.textContent = result.accepted
        ? `Accepted ${result.accepted} alert packet${result.accepted === 1 ? '' : 's'} — sending now, and carried by the relay radios if there is no connection.`
        : (result.skipped ? 'Nothing new in that file (already received or expired).' : 'That file did not contain a usable REACH alert.');
    }
    if (result.accepted) await refreshRelayProgress?.();
  } catch (error) {
    if (statusEl) statusEl.textContent = error?.message || 'That file could not be read.';
  }
}

/** Entering the relay screen: show real capability and ask the radios to be turned on.
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
    // An optional estate join code binds the citizen to their estate so reports route to its desk.
    // A bad code must not fail the registration; report it and continue.
    const joinCode = $('#registerJoinCode')?.value?.trim();
    if (joinCode) {
      try { await joinInstitution(joinCode); await refreshEstateStatus(); }
      catch (error) { alert(error?.message || 'That estate join code was not accepted. You can join later from your home screen.'); }
    }
    return true;
  } catch (error) { alert(error.message || 'Account creation failed.'); return false; }
  finally { registrationInFlight = false; }
}

async function handleCitizenLogin() {
  const email = $('#loginEmail')?.value?.trim().toLowerCase() || '';
  const password = $('#loginPassword')?.value || '';
  if (!email || !password) { alert('Enter your email and password.'); return; }
  try { await login({email,password}); await flushCitizenQueue(); void refreshEstateStatus(); navigateTo('relaypermission'); } catch (error) { alert(error.message || 'Unable to sign in.'); }
}

async function flushCitizenQueue() {
  const { flushQueue } = await import('./backend.js');
  await flushQueue();
}

/** The GPS row's live status text, so failures are shown in place rather than via alert(). */
function setGpsOptionText(text) {
  const span = document.querySelector('#locList [data-loc-type="gps"] span');
  if (span) span.textContent = text;
}

/**
 * Read the device location with a real user prompt.
 *
 * Two things make this fail in the field and are handled explicitly:
 * - On iOS Safari (and anything without the Permissions API) a *denied* location grant can only be
 *   reported through `getCurrentPosition`, which resolves nothing when a previously-denied caller
 *   retries — so it is wrapped in a timeout instead of hanging on "Reading GPS…" forever.
 * - `enableHighAccuracy` outdoors takes a long time to fix, so the first attempt is time-bounded and
 *   falls back to a coarse network fix rather than leaving the citizen with no location at all.
 *
 * Nothing is written to state unless a fix is actually obtained, so a failed read never overwrites
 * the registered/manual choice with null coordinates.
 */
function readGpsFix() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('unsupported')); return; }
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    const attempt = (options, onFail) => {
      navigator.geolocation.getCurrentPosition(
        position => finish(resolve, position),
        error => onFail(error),
        options,
      );
    };
    // A denied/retried call may never invoke either callback, so cap the wait per attempt.
    const watchdog = (ms, onTimeout) => setTimeout(() => onTimeout(), ms);
    const coarse = () => {
      const t = watchdog(12000, () => finish(reject, new Error('timeout')));
      attempt({ enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }, error => {
        clearTimeout(t);
        finish(reject, error);
      });
    };
    const t = watchdog(10000, coarse);
    attempt({ enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }, error => {
      clearTimeout(t);
      if (error && error.code === 1) { finish(reject, error); return; } // permission denied — retrying is pointless
      coarse();
    });
  });
}

/**
 * GPS row tap: read a fix and show the real outcome.
 *
 * Tapping the row also selects it (the loc-list handler runs in the same click), so a *failed* read
 * must fall back to the registered zone rather than leaving "GPS" selected with no coordinates — the
 * report would otherwise claim a GPS source it never obtained.
 */
async function requestGpsLocation() {
  const row = document.querySelector('#locList [data-loc-type="gps"]');
  if (!navigator.geolocation) { setGpsOptionText('GPS not available on this device'); selectRegisteredFallback(); return; }
  if (row?.classList.contains('locating')) return;
  row?.classList.add('locating');
  setGpsOptionText('Reading GPS…');

  let position = null, error = null;
  try { position = await readGpsFix(); } catch (e) { error = e; }
  row?.classList.remove('locating');

  // The citizen may have switched back to their registered zone while the fix was pending.
  const stillChosen = row?.classList.contains('selected');

  if (position) {
    const { latitude, longitude, accuracy } = position.coords;
    setGpsOptionText(`Current location · ±${Math.round(accuracy)}m — tap to use`);
    // Writing the fix notifies subscribers, which refresh the Review summary via syncLocationScreen().
    if (stillChosen) setGpsCoordinates(latitude, longitude, accuracy);
    return;
  }
  setGpsOptionText(error?.code === 1
    ? 'Location permission denied — allow it in your browser settings'
    : 'Unable to read GPS — choose another option');
  if (stillChosen) selectRegisteredFallback();
}

/** Drop back to the citizen's registered zone when GPS cannot be used. */
function selectRegisteredFallback() {
  const registered = document.querySelector('#locList [data-loc-type="registered"]');
  if (registered) handleLocationSelect(registered);
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

/** Show the citizen's registered zone on the location screen, and keep the Review summary current. */
function syncLocationScreen() {
  const zone = appState.user.registeredLocation;
  const row = document.querySelector('#locList [data-loc-type="registered"]');
  const span = row?.querySelector('span');
  // The default is a placeholder, not a zone; only overwrite the static row once a real zone exists.
  if (span && zone && zone !== 'Select your registered zone') span.textContent = zone;
  // This runs from the state subscriber, so writing state here must be idempotent — otherwise the
  // notify would re-enter this function forever.
  const label = span?.textContent.trim() || zone || 'Zone B';
  if (row?.classList.contains('selected') && appState.emergency.locationLabel !== label) {
    setSelectedLocation('registered', label);
    return; // the write already refreshed the summary via the subscriber
  }
  const confirmLoc = $('#confirmLocType');
  if (confirmLoc) confirmLoc.textContent = confirmLocationText();
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
    text.textContent = 'Relay status is unavailable right now. Your alert is kept on this device until it can be sent.';
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

/** Show the estate this citizen is linked to, so it is clear where reports are routed. */
function renderEstateChip(name) {
  const chip = $('#homeEstateChip');
  const text = $('#homeEstateText');
  const joinBtn = $('#homeJoinEstate');
  if (chip && text) {
    if (name) { text.textContent = `Reports routed to ${name}`; chip.style.display = 'flex'; }
    else { chip.style.display = 'none'; }
  }
  // Only offer the join entry once we know the server says this citizen is not linked yet.
  if (joinBtn) joinBtn.style.display = name ? 'none' : 'block';
}

/**
 * Fetch the signed-in profile and reflect the linked estate. Best-effort: an offline citizen
 * keeps the cached value and the chip stays hidden until the server answers.
 */
async function refreshEstateStatus() {
  if (!backendConfigured || !hasSession()) return;
  try {
    const profile = await getProfile();
    if (profile?.institution_name) {
      appState.user.estateName = profile.institution_name;
      localStorage.setItem('reach_pwa_profile', JSON.stringify(appState.user));
    }
    renderEstateChip(profile?.institution_name || null);
  } catch { /* keep whatever the cache showed */ }
}

/** Redeem a join code and bind this citizen to the estate. */
async function submitEstateJoin() {
  const input = $('#joinEstateCode');
  const status = $('#joinEstateStatus');
  const code = input?.value?.trim();
  if (!code) { if (status) status.textContent = 'Enter the code your estate office gave you.'; return; }
  if (!backendConfigured || !hasSession()) { if (status) status.textContent = 'Connect to the internet once to join an estate.'; return; }
  if (status) status.textContent = 'Joining…';
  try {
    await joinInstitution(code);
    if (input) input.value = '';
    if (status) status.textContent = 'Joined. Your reports will now reach this estate.';
    await refreshEstateStatus();
  } catch (error) {
    if (status) status.textContent = error?.message || 'That join code was not accepted.';
  }
}

/** Offer the join screen right after a report, but only if this citizen is not linked yet. */
function offerEstateJoinAfterReport() {
  const btn = $('#trackingJoinEstate');
  if (!btn) return;
  if (!backendConfigured || !hasSession()) { btn.style.display = 'none'; return; }
  void getProfile().then(profile => {
    if (profile?.institution_id) {
      btn.style.display = 'none';
      renderEstateChip(profile.institution_name || null);
    } else {
      btn.style.display = 'block';
    }
  }).catch(() => { btn.style.display = 'none'; });
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
  if (target === 'location') { syncLocationScreen(); }
  if (target === 'relaynotify') { void renderRelayNotify(); }
  if (target === 'confirm') { void renderCaptureList(); }
  if (target === 'join') { void refreshEstateStatus(); }
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
    } else if (result.status === 'relay-queued') {
      // Handed to the native relay node, but not yet carried — say so instead of claiming delivery.
      if (title) title.textContent = 'Handed to the relay node';
      if (sub) sub.textContent = result.message || 'It will be carried to REACH as soon as a nearby device or a connection is available.';
    }
    navigateTo(target);
    void trackActiveIncident();
    offerEstateJoinAfterReport();
    return true;
  }
  return false;
}

// Capture phase ensures the enhanced actions run before the generic navigation handler.
document.addEventListener('click', (event) => { void enhancedNavHandler(event); }, true);

const joinSubmit = $('#joinEstateSubmit');
if (joinSubmit) joinSubmit.addEventListener('click', () => { void submitEstateJoin(); });

const savedProfile = (() => { try { return JSON.parse(localStorage.getItem('reach_pwa_profile') || 'null'); } catch { return null; } })();
if (savedProfile) Object.assign(appState.user, savedProfile);
registerScreenRenderers({ history: renderIncidentHistory, relayProgress: refreshRelayProgress });
initBackendSync();
syncProfileIntoHome();
syncNetworkUi();
if (appState.user.estateName) renderEstateChip(appState.user.estateName);
void refreshEstateStatus();
void requestRadiosOnOpen();
window.setInterval(() => { if (appState.currentScreen === 'home') void refreshRelayProgress(); }, 15000);
const demoResolve = $('#demoResolveButton');
const demoRelay = $('#demoRelayButton');
if (backendConfigured) { if (demoResolve) demoResolve.style.display = 'none'; if (demoRelay) demoRelay.style.display = 'none'; }
if (backendConfigured) { setNetworkAvailable(navigator.onLine); }
window.setInterval(() => { if (appState.currentScreen === 'tracking') void trackActiveIncident(); }, 10000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => undefined);
