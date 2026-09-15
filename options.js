const ALARM_NAME = "check-odyssey";

const FIELDS = ["enabled", "desktopNotifications", "intervalMinutes"];

async function load() {
  await showPinHintIfUnpinned();
  await showCookieReport();
  const stored = await chrome.storage.local.get(FIELDS);
  document.getElementById("enabled").checked = stored.enabled !== false;
  const desktopOn = stored.desktopNotifications !== false;
  document.getElementById("desktopNotifications").checked = desktopOn;
  document.getElementById("permissionCheck").style.display = desktopOn ? "" : "none";
  // Must use the same default as background.js, or the field shows a number
  // the alarm is not actually using.
  document.getElementById("intervalMinutes").value = clampIntervalMinutes(stored.intervalMinutes);

  if (desktopOn) await checkNotificationPermission();
}

// H4: the badge is drawn on the extension icon, which Chrome does not pin by
// default. An extension cannot pin itself, so tell the user how.
async function showPinHintIfUnpinned() {
  try {
    const { isOnToolbar } = await chrome.action.getUserSettings();
    document.getElementById("pinHint").hidden = isOnToolbar !== false;
  } catch (err) {
    // getUserSettings needs Chrome 91+; on older builds just leave the hint off.
  }
}

// Records which cookie-banner button the extension last clicked. The click is
// far too fast to watch on the page, so it is reported here instead.
async function showCookieReport() {
  const el = document.getElementById("cookieReport");
  const { lastCookieBanner } = await chrome.storage.local.get("lastCookieBanner");
  if (!lastCookieBanner) return;

  const when = new Date(lastCookieBanner.at).toLocaleString();
  if (!lastCookieBanner.clicked) {
    el.textContent = `Last booking page (${when}): no cookie banner was showing, so nothing was clicked.`;
    return;
  }

  const accepted = /accept/i.test(lastCookieBanner.clicked);
  el.textContent =
    `Last booking page (${when}): clicked "${lastCookieBanner.clicked}"` +
    (accepted
      ? " - that banner offered no reject option."
      : " - your cookies were not accepted.") +
    (lastCookieBanner.offered?.length ? ` Buttons offered: ${lastCookieBanner.offered.join(", ")}.` : "");
  el.style.color = accepted ? "#b06a10" : "";
}

async function checkNotificationPermission() {
  const warning = document.getElementById("permissionWarning");
  const result = await sendMessageSafe({ type: "GET_NOTIFICATION_PERMISSION" });
  const level = result?.permissionLevel;

  if (!level || level === "granted") {
    warning.style.display = "none";
    return;
  }

  warning.textContent = `Chrome itself is blocking notifications (permission: ${level}) - desktop alerts won't show up even with the toggle on. Check your operating system's notification settings for Chrome.`;
  warning.style.display = "block";
}

document.getElementById("testNotification")?.addEventListener("click", async () => {
  const status = document.getElementById("testNotificationStatus");
  const confirmRow = document.getElementById("notificationConfirm");
  status.textContent = "Sending…";
  status.className = "test-status";
  confirmRow.style.display = "none";

  const result = await sendMessageSafe({ type: "TEST_NOTIFICATION" });
  if (!result?.ok) {
    status.textContent = `Couldn't send it: ${result?.error || "unknown error"}`;
    status.className = "test-status fail";
    return;
  }
  status.textContent = "Sent.";
  status.className = "test-status ok";
  confirmRow.style.display = "block";
});

document.getElementById("notifSeenYes")?.addEventListener("click", () => {
  document.getElementById("notificationConfirm").style.display = "none";
  const status = document.getElementById("testNotificationStatus");
  status.textContent = "Good - desktop notifications are actually working.";
  status.className = "test-status ok";
});

document.getElementById("notifSeenNo")?.addEventListener("click", () => {
  document.getElementById("notificationConfirm").style.display = "none";
  const status = document.getElementById("testNotificationStatus");
  status.textContent = "Then something is blocking it outside Chrome - check your operating system's notification settings for Google Chrome and make sure notifications are allowed.";
  status.className = "test-status fail";
});

function syncAlarm(enabled, intervalMinutes) {
  if (enabled === false) {
    chrome.alarms.clear(ALARM_NAME);
  } else {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: clampIntervalMinutes(intervalMinutes) });
  }
}

function flashStatus(text) {
  const status = document.getElementById("status");
  status.textContent = text;
  setTimeout(() => (status.textContent = ""), 1500);
}

document.getElementById("enabled")?.addEventListener("change", async (e) => {
  const enabled = e.target.checked;
  await chrome.storage.local.set({ enabled });
  const { intervalMinutes } = await chrome.storage.local.get("intervalMinutes");
  syncAlarm(enabled, intervalMinutes);
  flashStatus(enabled ? "Auto-check on" : "Auto-check off");
});

document.getElementById("desktopNotifications")?.addEventListener("change", async (e) => {
  const desktopOn = e.target.checked;
  await chrome.storage.local.set({ desktopNotifications: desktopOn });
  document.getElementById("permissionCheck").style.display = desktopOn ? "" : "none";
  if (desktopOn) await checkNotificationPermission();
  flashStatus(desktopOn ? "Desktop notification on" : "Desktop notification off");
});

// L5: the two switches saved on change but the interval needed the Save button,
// so a user who typed a value and closed the page lost it silently. Everything
// saves on change now and the button is gone.
async function saveInterval() {
  const field = document.getElementById("intervalMinutes");
  const intervalMinutes = clampIntervalMinutes(field.value);
  field.value = intervalMinutes;
  await chrome.storage.local.set({ intervalMinutes });

  const { enabled } = await chrome.storage.local.get("enabled");
  syncAlarm(enabled, intervalMinutes);

  flashStatus(`Checking every ${intervalMinutes} min`);
}

document.addEventListener("DOMContentLoaded", load);
document.getElementById("intervalMinutes")?.addEventListener("change", saveInterval);

