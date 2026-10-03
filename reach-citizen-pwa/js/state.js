/**
 * REACH Mobile App - Application State
 *
 * This module isolates all state management for the mobile application.
 * In a future React conversion, this maps directly to React useState/useReducer or Context.
 */

export const appState = {
  // Navigation & view
  currentScreen: 'splash',

  // User Profile
  user: {
    name: '',
    phone: '',
    registeredLocation: 'Select your registered zone'
  },

  // Relay Setting (Phone carries offline emergency packets)
  relayEnabled: true,

  // Active Emergency Report
  emergency: {
    category: 'fire', // 'fire' | 'medical' | 'security' | 'accident'
    categoryLabel: 'Fire',
    locationType: 'registered', // 'registered' | 'gps' | 'manual'
    locationLabel: 'Zone B',
    priority: 'high',
    confidenceScore: '91% · AI + you',
    networkStatus: 'No signal',
    incidentId: null,
    incidentCode: null,
    deliveryMethod: 'Offline relay',
    latitude: null,
    longitude: null,
    locationAccuracyM: null,
    networkAvailable: typeof navigator !== 'undefined' ? navigator.onLine : true
  },

  // AI Perception & Detection Simulation State
  aiDetection: {
    motionDetected: false,
    visualDetected: false,
    audioDetected: false,
    confidencePct: 0
  }
};

// Listeners for state changes
const listeners = new Set();

/**
 * Subscribe to state changes
 * @param {Function} listener - Callback function receiving current state
 * @returns {Function} Unsubscribe function
 */
export function subscribeState(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Notify all subscribers of state updates
 */
function notifySubscribers() {
  for (const listener of listeners) {
    try {
      listener(appState);
    } catch (err) {
      console.error('State subscriber error:', err);
    }
  }
}

/**
 * Toggle or set the background relay state
 * @param {boolean} [explicitState] - Optional explicit boolean value
 * @returns {boolean} Updated relay status
 */
export function setRelayEnabled(explicitState) {
  if (typeof explicitState === 'boolean') {
    appState.relayEnabled = explicitState;
  } else {
    appState.relayEnabled = !appState.relayEnabled;
  }
  notifySubscribers();
  return appState.relayEnabled;
}

/**
 * Set the active emergency category
 * @param {string} categoryKey - 'fire' | 'medical' | 'security' | 'accident'
 * @param {string} label - Human-readable label
 */
export function setSelectedCategory(categoryKey, label) {
  appState.emergency.category = categoryKey;
  if (label) {
    appState.emergency.categoryLabel = label;
  }
  notifySubscribers();
}

/**
 * Set the emergency location option
 * @param {string} locationType - 'registered' | 'gps' | 'manual'
 * @param {string} label - Human-readable label
 */
export function setSelectedLocation(locationType, label) {
  appState.emergency.locationType = locationType;
  if (label) {
    appState.emergency.locationLabel = label;
  }
  // Coordinates belong to the GPS fix only. Leaving it for a zone must drop the stale fix, or the
  // report would ship a "Zone B" label alongside the last GPS point.
  if (locationType !== 'gps') {
    appState.emergency.latitude = null;
    appState.emergency.longitude = null;
    appState.emergency.locationAccuracyM = null;
  }
  notifySubscribers();
}

/**
 * Reset AI detection simulation state
 */
export function resetAiDetectionState() {
  appState.aiDetection = {
    motionDetected: false,
    visualDetected: false,
    audioDetected: false,
    confidencePct: 0
  };
  notifySubscribers();
}


export function setGpsCoordinates(latitude, longitude, accuracy = null) {
  appState.emergency.latitude = Number.isFinite(latitude) ? latitude : null;
  appState.emergency.longitude = Number.isFinite(longitude) ? longitude : null;
  appState.emergency.locationAccuracyM = Number.isFinite(accuracy) ? accuracy : null;
  appState.emergency.locationType = 'gps';
  appState.emergency.locationLabel = accuracy ? `Current GPS location (±${Math.round(accuracy)}m)` : 'Current GPS location';
  notifySubscribers();
}

export function setNetworkAvailable(available) {
  appState.emergency.networkAvailable = Boolean(available);
  notifySubscribers();
}
