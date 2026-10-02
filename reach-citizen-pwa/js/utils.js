/**
 * REACH Mobile App - Utility Functions
 */

/**
 * Select a single DOM element matching selector
 * @param {string} selector - CSS selector
 * @param {Element|Document} [parent=document] - Parent context
 * @returns {Element|null}
 */
export function $(selector, parent = document) {
  return parent.querySelector(selector);
}

/**
 * Select all DOM elements matching selector as an Array
 * @param {string} selector - CSS selector
 * @param {Element|Document} [parent=document] - Parent context
 * @returns {Element[]}
 */
export function $$(selector, parent = document) {
  return Array.from(parent.querySelectorAll(selector));
}

/**
 * Set text content safely if element exists
 * @param {string|Element} target - Element ID or Element
 * @param {string} text - Content to set
 */
export function setText(target, text) {
  const el = typeof target === 'string' ? document.getElementById(target) : target;
  if (el) {
    el.textContent = text;
  }
}

/**
 * Set inner HTML safely if element exists
 * @param {string|Element} target - Element ID or Element
 * @param {string} html - HTML string to set
 */
export function setHTML(target, html) {
  const el = typeof target === 'string' ? document.getElementById(target) : target;
  if (el) {
    el.innerHTML = html;
  }
}

/**
 * Compute the lowercase hex SHA-256 of a Blob or ArrayBuffer.
 *
 * Used as the evidence object's content address: the server stores the hash and the object path is
 * derived from it. The engine collapses two media rows that share kind/source/timestamp/category,
 * and the API stamps every row of one incident with the same reported_at, so re-uploading the same
 * file cannot be counted as a second independent contribution.
 *
 * @param {Blob|ArrayBuffer|Uint8Array} input
 * @returns {Promise<string>} 64-character lowercase hex digest
 */
export async function sha256Hex(input) {
  const buffer = input instanceof ArrayBuffer
    ? input
    : input instanceof Uint8Array
      ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
      : await input.arrayBuffer();
  if (!globalThis.crypto?.subtle) throw new Error('Secure hashing is unavailable in this browser context');
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Derive the evidence kind the server accepts from a file's MIME type.
 * Returns null for types the capture path does not accept.
 *
 * @param {string} mimeType
 * @returns {'image'|'audio'|'video'|null}
 */
export function evidenceKindForMime(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return null;
}

/**
 * Manage timed tasks so they can be canceled collectively when leaving a screen
 * @returns {{ add: Function, clearAll: Function }}
 */
export function createTimerGroup() {
  const timerIds = [];

  return {
    add(fn, delayMs) {
      const id = setTimeout(() => {
        const idx = timerIds.indexOf(id);
        if (idx !== -1) timerIds.splice(idx, 1);
        fn();
      }, delayMs);
      timerIds.push(id);
      return id;
    },
    clearAll() {
      while (timerIds.length > 0) {
        clearTimeout(timerIds.pop());
      }
    }
  };
}
