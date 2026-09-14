const ALARM_NAME = "check-odyssey";

const FIELDS = ["enabled", "desktopNotifications", "intervalMinutes"];

async function load() {
  const stored = await chrome.storage.local.get(FIELDS);
  document.getElementById("enabled").checked = stored.enabled !== false;
  const desktopOn = stored.desktopNotifications !== false;
  document.getElementById("desktopNotifications").checked = desktopOn;
  document.getElementById("permissionCheck").style.display = desktopOn ? "" : "none";
  document.getElementById("intervalMinutes").value = stored.intervalMinutes || 1;

  if (desktopOn) await checkNotificationPermission();
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

async function sendMessageSafe(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (err) {
    console.error("sendMessage failed - the extension was likely reloaded; refresh this page.", err);
    return null;
  }
}

function syncAlarm(enabled, intervalMinutes) {
  if (enabled === false) {
    chrome.alarms.clear(ALARM_NAME);
  } else {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: Math.min(60, Math.max(1, intervalMinutes || 1)) });
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

async function save() {
  const intervalMinutes = Math.min(60, Math.max(1, Number(document.getElementById("intervalMinutes").value) || 1));
  await chrome.storage.local.set({ intervalMinutes });

  const { enabled } = await chrome.storage.local.get("enabled");
  syncAlarm(enabled, intervalMinutes);

  flashStatus("Saved");
}

document.addEventListener("DOMContentLoaded", load);
document.getElementById("save")?.addEventListener("click", save);

