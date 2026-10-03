/**
 * REACH Mobile App - Navigation Controller
 *
 * Manages screen transitions, status bar presentation, rail active states,
 * and screen lifecycle hooks.
 *
 * In a future React conversion, this maps to React Router or a state-based
 * screen navigator (e.g. NavigationContainer / Tab / Stack navigator).
 */

import { appState } from './state.js';
import { $, $$, setText, setHTML, createTimerGroup } from './utils.js';

/**
 * Screen metadata dictionary
 */
export const SCREEN_CONFIG = {
  splash: {
    index: 1,
    title: 'Splash',
    signal: null,
    showStatusBar: false
  },
  onboarding: {
    index: 2,
    title: 'Onboarding',
    signal: null,
    showStatusBar: false
  },
  register: {
    index: 3,
    title: 'Registration',
    signal: 'yes',
    showStatusBar: true
  },
  login: {
    index: 4,
    title: 'Sign in',
    signal: 'yes',
    showStatusBar: true
  },
  relaypermission: {
    index: 5,
    title: 'Enable relay',
    signal: 'yes',
    showStatusBar: true
  },
  home: {
    index: 6,
    title: 'Home · SOS button',
    signal: 'no',
    showStatusBar: true
  },
  aidetect: {
    index: 7,
    title: 'AI detection',
    signal: 'no',
    showStatusBar: true
  },
  category: {
    index: 8,
    title: 'Emergency type',
    signal: 'no',
    showStatusBar: true
  },
  location: {
    index: 9,
    title: 'Location',
    signal: 'no',
    showStatusBar: true
  },
  confirm: {
    index: 10,
    title: 'Confirm',
    signal: 'no',
    showStatusBar: true
  },
  tracking: {
    index: 11,
    title: 'Live status',
    signal: 'weak',
    showStatusBar: true
  },
  resolved: {
    index: 12,
    title: 'Incident history',
    signal: 'yes',
    showStatusBar: true
  },
  historydetail: {
    index: 12,
    title: 'Incident detail',
    signal: 'yes',
    showStatusBar: true
  },
  contacts: {
    index: 13,
    title: 'Trusted contacts',
    signal: 'yes',
    showStatusBar: true
  },
  relaynotify: {
    index: 14,
    title: 'Relay notification',
    signal: 'yes',
    showStatusBar: false
  },
  relaytransfer: {
    index: 15,
    title: 'Packet transfer view',
    signal: 'yes',
    showStatusBar: true
  }
};

export const TOTAL_SCREENS = Object.keys(SCREEN_CONFIG).length;

// Timer manager for screen-specific animations (AI detection, etc.)
const screenTimers = createTimerGroup();

/**
 * Update the phone chassis status bar
 * @param {object} config - Current screen config
 */
function updateStatusBar(config) {
  const statusBar = $('#statusBar');
  const signalTag = $('#signalTag');
  if (!statusBar || !signalTag) return;

  if (!config.showStatusBar || config.signal === null) {
    statusBar.classList.add('hidden');
    return;
  }

  statusBar.classList.remove('hidden');

  const signalMap = {
    no: { className: 'signal-tag no', label: 'NO SIGNAL' },
    weak: { className: 'signal-tag weak', label: 'WEAK SIGNAL' },
    yes: { className: 'signal-tag yes', label: '4G' }
  };

  const signalInfo = signalMap[config.signal] || signalMap.yes;
  signalTag.className = signalInfo.className;
  signalTag.textContent = signalInfo.label;
}


/**
 * Render the capture list on the evidence review screen.
 *
 * Shows what the citizen has actually captured, with the fusion weight the server will assign.
 * Nothing here is simulated: an empty list means no evidence has been collected, and the screen
 * says so rather than implying signals were detected.
 */
async function renderEvidenceReview() {
  const fusionList = $('#fusionList');
  const confirmSlot = $('#aiConfirmSlot');
  if (!fusionList) return;

  const { listEvidenceQueue, CAPTURE_KINDS } = await import('./evidence.js');

  let rows = [];
  try { rows = await listEvidenceQueue(); } catch { rows = []; }

  const label = { image: 'Photo', audio: 'Audio', video: 'Video' };
  const weight = { image: 'strong', audio: 'moderate', video: 'moderate' };

  fusionList.innerHTML = '';
  if (!rows.length) {
    const row = document.createElement('div');
    row.className = 'fusion-row weak';
    row.innerHTML = '<div class="fd"></div><div><b>No evidence captured yet</b><span>Use Photo, Audio or Video above — you can also attach evidence later</span></div>';
    fusionList.appendChild(row);
  } else {
    for (const item of rows) {
      const row = document.createElement('div');
      row.className = 'fusion-row';
      row.innerHTML = `<div class="fd"></div><div><b>${label[item.kind] || item.kind} attached</b><span>${weight[item.kind] || 'moderate'} evidence · held on this device until you send</span></div>`;
      fusionList.appendChild(row);
    }
  }

  const kinds = CAPTURE_KINDS;
  if (confirmSlot) {
    confirmSlot.innerHTML = `
      <div class="ai-confirm-box">
        <b>Evidence is optional</b>
        <p>REACH fuses whatever you attach with your report, and a responder reviews everything before anyone is dispatched. ${rows.length ? 'Your captures are held on this device until you send the alert.' : 'You can send without any evidence.'}</p>
      </div>
      <div class="stack" style="margin-top:14px;">
        <button class="btn-primary" data-nav="category">Continue</button>
        <button class="btn-text" data-nav="home">Back to home</button>
      </div>`;
  }

  // Chip state reflects what is actually held, not a scripted animation.
  for (const kind of kinds) {
    const chip = kind === 'image' ? $('#senseVisual') : kind === 'audio' ? $('#senseAudio') : $('#senseVideo');
    if (chip) chip.classList.toggle('on', rows.some(r => r.kind === kind));
  }
}

/** Queue a capture taken on the review screen. It has no incident yet, so it is bound at send.
 * Assigning `onchange` rather than adding a listener keeps this idempotent: the screen is entered
 * more than once, and stacked listeners would queue the same file repeatedly. */
function captureFromReview(inputId, kind) {
  const input = $(inputId);
  if (!input) return;
  input.onchange = async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const { queueEvidenceCapture } = await import('./evidence.js');
    await queueEvidenceCapture({ incidentId: null, incidentKey: null, kind, blob: file, mime: file.type, meta: { name: file.name, size: file.size } });
    await renderEvidenceReview();
  };
}

/**
 * Wire the evidence review screen: capture chips open the right picker, and the list reflects
 * what is actually held on the device.
 */
function runAiDetectionSequence() {
  const visual = $('#senseVisual');
  const audio = $('#senseAudio');
  const video = $('#senseVideo');
  if (visual) visual.onclick = () => $('#reviewCamera')?.click();
  if (audio) audio.onclick = () => $('#reviewAudio')?.click();
  if (video) video.onclick = () => $('#reviewVideo')?.click();
  captureFromReview('#reviewCamera', 'image');
  captureFromReview('#reviewAudio', 'audio');
  captureFromReview('#reviewVideo', 'video');
  void renderEvidenceReview();
}

/**
 * Navigate to a specific screen
 * @param {string} screenKey - Key matching SCREEN_CONFIG
 */
export function navigateTo(screenKey) {
  const config = SCREEN_CONFIG[screenKey];
  if (!config) {
    console.warn(`[Navigation] Screen '${screenKey}' not found.`);
    return;
  }

  // Cancel any running timers from previous screen (e.g. AI simulation)
  screenTimers.clearAll();

  // Update application state
  appState.currentScreen = screenKey;

  // Toggle active screen visibility
  const allScreens = $$('.screen-view');
  allScreens.forEach(screen => {
    const isTarget = screen.id === `screen-${screenKey}`;
    screen.classList.toggle('active', isTarget);
    if (isTarget) {
      screen.scrollTop = 0;
    }
  });

  // Update presentation chrome
  updateStatusBar(config);

  // Trigger screen-specific lifecycle
  if (screenKey === 'splash') {
    // Auto-advance splash screen after 2 seconds
    screenTimers.add(() => {
      navigateTo('onboarding');
    }, 2000);
  } else if (screenKey === 'aidetect') {
    runAiDetectionSequence();
  } else if (screenKey === 'resolved') {
    renderHistoryScreen();
  } else if (screenKey === 'home') {
    refreshRelayProgress();
  }
}

// Assigned by app.js after import. navigation.js is imported before app.js's module body runs, so a
// direct import would be a cycle; the hooks are optional and guarded. The history detail renderer is
// driven by the row click (which knows the id), not by navigation.
let renderHistoryScreen = () => {};
let refreshRelayProgress = () => {};

/** app.js registers the history/relay renderers here to avoid an import cycle. */
export function registerScreenRenderers({ history, relayProgress } = {}) {
  if (history) renderHistoryScreen = history;
  if (relayProgress) refreshRelayProgress = relayProgress;
}
