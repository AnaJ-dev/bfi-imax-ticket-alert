// L4: shared helpers for popup.js, history.js and options.js. These were copied
// across three files and drifted apart - that drift is what left popup.js
// without escapeHtml (issue M1). Loaded before the page scripts in each HTML
// file. background.js is a service worker and does not use this file.

const WEEKDAY_ABBREVIATIONS = {
  Sunday: "Sun",
  Monday: "Mon",
  Tuesday: "Tue",
  Wednesday: "Wed",
  Thursday: "Thu",
  Friday: "Fri",
  Saturday: "Sat",
};

function formatDateTime(dt) {
  return String(dt).replace(/^(\w+)/, (day) => WEEKDAY_ABBREVIATIONS[day] || day);
}

function parseDateTime(dt) {
  return new Date(String(dt).replace(/^\w+\s+/, ""));
}

function sortByDateTime(times) {
  return [...times].sort((a, b) => parseDateTime(a) - parseDateTime(b));
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// L6: background.js and options.js clamped the interval differently, so a bad
// stored value reached chrome.alarms.create. One definition, used by both.
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 60;
const DEFAULT_INTERVAL_MINUTES = 5;

function clampIntervalMinutes(value) {
  // Number(null) is 0, which would clamp up to the 1-minute minimum - the most
  // aggressive setting. Treat null like undefined and use the default.
  if (value === null || value === undefined || value === "") return DEFAULT_INTERVAL_MINUTES;
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_MINUTES;
  return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(n)));
}

async function sendMessageSafe(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (err) {
    // L11: the popup used to swallow this, which hid the H6 handoff failures.
    console.error("sendMessage failed - the extension was likely reloaded; refresh this page.", err);
    return null;
  }
}
