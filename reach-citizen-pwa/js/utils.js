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
