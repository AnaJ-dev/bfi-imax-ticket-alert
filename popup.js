const PAGE_SIZE = 10;
const DEFAULT_FILM = { title: "The Odyssey", permalink: "odyssey-the-film-imax-70mm-2026" };
let currentPage = 1;

async function sendMessageSafe(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (err) {
    return null;
  }
}

let displayedFilm = DEFAULT_FILM;
let watchedFilms = [];

const filmSelectBtn = document.getElementById("filmSelectBtn");
const filmSelectBtnLabel = document.getElementById("filmSelectBtnLabel");
const filmSelectList = document.getElementById("filmSelectList");

function renderFilmDropdown(films) {
  const allFilms = films.some((f) => f.permalink === displayedFilm.permalink) ? films : [displayedFilm, ...films];
  allFilms.sort((a, b) => a.title.localeCompare(b.title));

  filmSelectBtnLabel.textContent = displayedFilm.title;
  filmSelectList.innerHTML = allFilms
    .map(
      (f) =>
        `<div class="film-select-option${f.permalink === displayedFilm.permalink ? " selected" : ""}" role="option" data-permalink="${f.permalink}" data-title="${f.title.replace(
          /"/g,
          "&quot;"
        )}">${f.title}</div>`
    )
    .join("");
}

async function loadFilmDropdown() {
  const { cachedFilmList } = await chrome.storage.local.get("cachedFilmList");
  if (cachedFilmList?.length) renderFilmDropdown(cachedFilmList);

  const response = await sendMessageSafe({ type: "GET_FILM_LIST" });
  const films = response?.films || [];
  if (films.length) renderFilmDropdown(films);
}

function closeFilmSelect() {
  filmSelectList.hidden = true;
  filmSelectBtn.classList.remove("open");
  filmSelectBtn.setAttribute("aria-expanded", "false");
}

filmSelectBtn.addEventListener("click", () => {
  const isOpen = !filmSelectList.hidden;
  if (isOpen) {
    closeFilmSelect();
  } else {
    filmSelectList.hidden = false;
    filmSelectBtn.classList.add("open");
    filmSelectBtn.setAttribute("aria-expanded", "true");
  }
});

async function switchDisplayedFilm(film) {
  closeFilmSelect();
  filmSelectBtnLabel.textContent = film.title;
  filmSelectList.querySelectorAll(".film-select-option").forEach((el) => {
    el.classList.toggle("selected", el.dataset.permalink === film.permalink);
  });

  await sendMessageSafe({ type: "SET_FILM", film });
  currentPage = 1;
  document.getElementById("meta").textContent = "Checking…";
  await sendMessageSafe({ type: "CHECK_NOW" });
  await render();
}

filmSelectList.addEventListener("click", async (e) => {
  const option = e.target.closest(".film-select-option");
  if (!option) return;
  await switchDisplayedFilm({ title: option.dataset.title, permalink: option.dataset.permalink });
});

document.addEventListener("click", (e) => {
  if (!filmSelectList.hidden && !e.target.closest(".film-select")) closeFilmSelect();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeFilmSelect();
});

function isDisplayedFilmWatched() {
  return watchedFilms.some((f) => f.permalink === displayedFilm.permalink);
}

function renderWatchToggle() {
  const btn = document.getElementById("watchToggle");
  const watched = isDisplayedFilmWatched();
  if (!watched) {
    btn.textContent = "🔔 Get notified for all screenings";
    btn.classList.remove("active");
  } else if (notifyDateTimes.size === 0) {
    btn.textContent = "✓ Notified for all screenings - tap to stop";
    btn.classList.add("active");
  } else {
    btn.textContent = `Switch to all screenings (currently ${notifyDateTimes.size} specific)`;
    btn.classList.add("active");
  }
}

document.getElementById("watchToggle")?.addEventListener("click", async () => {
  const watched = isDisplayedFilmWatched();
  if (watched && notifyDateTimes.size === 0) {
    await sendMessageSafe({ type: "REMOVE_WATCH", permalink: displayedFilm.permalink });
    await render();
    return;
  }

  if (!watched) await sendMessageSafe({ type: "ADD_WATCH", film: displayedFilm });
  await sendMessageSafe({ type: "SET_NOTIFY_SLOTS", permalink: displayedFilm.permalink, dateTimes: [] });
  await render();
  await showWatchFlash();
});

function formatStatus(status) {
  return status === "available" ? "✓" : status === "sold_out" ? "Sold out" : "Unknown";
}

const WEEKDAY_ABBREVIATIONS = {
  Sunday: "Sun",
  Monday: "Mon",
  Tuesday: "Tue",
  Wednesday: "Wed",
  Thursday: "Thu",
  Friday: "Fri",
  Saturday: "Sat",
};

function formatDateTime(dateTime) {
  return dateTime.replace(/^(\w+)/, (day) => WEEKDAY_ABBREVIATIONS[day] || day);
}

let notifyDateTimes = new Set();

function screeningRow(s) {
  const inner = `<span class="when">${formatDateTime(s.dateTime)}</span><span class="badge ${s.status}">${formatStatus(
    s.status
  )}</span>`;
  const dt = s.dateTime.replace(/"/g, "&quot;");

  if (s.status === "available") {
    return `<button type="button" class="screening available" data-datetime="${dt}" data-page="${s.page ||
      1}" title="Opens this exact screening's seat selection on BFI's site">${inner}</button>`;
  }

  const isWatched = notifyDateTimes.has(s.dateTime);
  const bell = `<button type="button" class="bell${isWatched ? " active" : ""}" data-datetime="${dt}" title="${
    isWatched ? "Notifying about this time - tap to stop watching it" : "Notify me about this specific time (as well as any others you pick)"
  }">${isWatched ? "🔔" : "🔕"}</button>`;
  return `<div class="screening ${s.status}">${inner}${bell}</div>`;
}

async function buildChannelBadge() {
  const { desktopNotifications } = await chrome.storage.local.get("desktopNotifications");
  const desktopOn = desktopNotifications !== false;
  const text = desktopOn
    ? "Desktop notification ✓"
    : `Desktop notification ✗ (<a href="options.html" target="_blank">turn on</a>)`;
  return { text, anyActive: desktopOn };
}

function showFlash(mainHtml, subHtml) {
  const flash = document.getElementById("bellFlash");
  const sub = subHtml ? `<div class="bell-flash-sub">${subHtml}</div>` : "";
  flash.innerHTML = `<div class="bell-flash-main">${mainHtml}</div>${sub}<button type="button" class="bell-flash-close" title="Dismiss">✕</button>`;
  flash.hidden = false;
}

document.getElementById("bellFlash")?.addEventListener("click", (e) => {
  if (e.target.closest(".bell-flash-close")) document.getElementById("bellFlash").hidden = true;
});

async function showWatchFlash() {
  const badge = await buildChannelBadge();
  const headline = badge.anyActive
    ? `Notified for any screening of <strong>${displayedFilm.title}</strong>`
    : `<strong>${displayedFilm.title}</strong> added, but you WON'T be notified - desktop notifications are off`;
  showFlash(headline, badge.text);
}

async function showBellFlash(added, dateTime, justStartedWatching = false, unfollowed = false) {
  const badge = await buildChannelBadge();
  const badgeSub = badge.anyActive ? badge.text : `WON'T notify - desktop notifications are off. ${badge.text}`;
  const followNote = justStartedWatching ? " - notifications turned on for this film" : "";

  if (unfollowed) {
    showFlash(`Removed <strong>${formatDateTime(dateTime)}</strong> - no times left, so you're no longer following <strong>${displayedFilm.title}</strong>`, null);
  } else if (notifyDateTimes.size === 0) {
    showFlash(`Watching any open slot${followNote}`, badgeSub);
  } else if (added) {
    const count = notifyDateTimes.size;
    showFlash(
      `Watching <strong>${formatDateTime(dateTime)}</strong>${count > 1 ? ` (+${count - 1} more)` : ""}${followNote}`,
      badgeSub
    );
  } else {
    const count = notifyDateTimes.size;
    showFlash(`Removed <strong>${formatDateTime(dateTime)}</strong> - ${count} left`, count > 0 ? badgeSub : null);
  }
}

document.getElementById("list")?.addEventListener("click", async (e) => {
  const bell = e.target.closest(".bell");
  if (bell) {
    const dateTime = bell.dataset.datetime;
    const added = !notifyDateTimes.has(dateTime);
    if (added) notifyDateTimes.add(dateTime);
    else notifyDateTimes.delete(dateTime);

    const wasWatched = isDisplayedFilmWatched();
    const justStartedWatching = added && !wasWatched;
    if (justStartedWatching) {
      await sendMessageSafe({ type: "ADD_WATCH", film: displayedFilm });
      watchedFilms.push(displayedFilm);
    }

    const unfollowed = !added && notifyDateTimes.size === 0;
    if (unfollowed) {
      await sendMessageSafe({ type: "REMOVE_WATCH", permalink: displayedFilm.permalink });
      watchedFilms = watchedFilms.filter((f) => f.permalink !== displayedFilm.permalink);
    } else {
      await sendMessageSafe({ type: "SET_NOTIFY_SLOTS", permalink: displayedFilm.permalink, dateTimes: [...notifyDateTimes] });
    }
    renderList();
    renderWatchToggle();
    await showBellFlash(added, dateTime, justStartedWatching, unfollowed);
    return;
  }

  const btn = e.target.closest(".screening.available");
  if (!btn) return;

  const dateTime = btn.dataset.datetime;
  const page = Number(btn.dataset.page) || 1;
  const badge = btn.querySelector(".badge");
  const originalBadgeText = badge.textContent;
  badge.textContent = "…";
  btn.disabled = true;

  const result = await sendMessageSafe({ type: "OPEN_SCREENING", screening: { dateTime, page } });

  badge.textContent = originalBadgeText;
  btn.disabled = false;
  if (!result?.ok) {
    document.getElementById("meta").textContent = `Couldn't open that screening: ${result?.reason || "unknown error"}`;
  }
});

let cachedScreenings = [];

let hasCheckedOnce = false;

function formatLastChecked(lastCheck) {
  if (!lastCheck) return "never";
  const d = new Date(lastCheck);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  return isToday ? d.toLocaleTimeString() : `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

async function render() {
  const { displayedFilm: df, watchedFilms: wf = [], filmStates = {} } = await chrome.storage.local.get([
    "displayedFilm",
    "watchedFilms",
    "filmStates",
  ]);
  displayedFilm = df || DEFAULT_FILM;
  watchedFilms = wf;

  const state = filmStates[displayedFilm.permalink] || {};
  cachedScreenings = state.lastScreenings || [];
  hasCheckedOnce = !!state.lastCheck;
  notifyDateTimes = new Set(state.notifyDateTimes || []);

  renderList();
  renderWatchToggle();

  const meta = document.getElementById("meta");
  const when = formatLastChecked(state.lastCheck);
  if (state.lastError) {
    meta.textContent = `Last check failed: ${state.lastError}`;
    meta.classList.add("error");
  } else {
    meta.textContent = `Last checked: ${when}`;
    meta.classList.remove("error");
  }

  await renderAlarmInfo();
}

document.getElementById("infoToggle")?.addEventListener("click", () => {
  const panel = document.getElementById("infoPanel");
  const btn = document.getElementById("infoToggle");
  const open = panel.hidden;
  panel.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
});

function renderList() {
  const sorted = [...cachedScreenings].sort((a, b) => {
    if (a.status === b.status) return 0;
    return a.status === "available" ? -1 : 1;
  });

  const list = document.getElementById("list");
  const pager = document.getElementById("pager");
  if (!sorted.length) {
    list.innerHTML = hasCheckedOnce
      ? '<div class="empty">No screening times yet - BFI hasn\'t announced dates for this film. Tap "Get notified for all screenings" above to hear the moment they do.</div>'
      : '<div class="empty">If no data is appearing, click "Check now".</div>';
    pager.hidden = true;
    return;
  }

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  currentPage = Math.min(Math.max(1, currentPage), totalPages);
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageItems = sorted.slice(start, start + PAGE_SIZE);

  list.innerHTML = pageItems.map(screeningRow).join("");

  const availableCount = sorted.filter((s) => s.status === "available").length;
  pager.hidden = totalPages <= 1;
  document.getElementById("pageInfo").textContent = `Page ${currentPage} of ${totalPages} · ${sorted.length} total, ${availableCount} open`;
  document.getElementById("prevPage").disabled = currentPage <= 1;
  document.getElementById("nextPage").disabled = currentPage >= totalPages;
}

let lastSecondsLeft = null;
let justRefreshedUntil = 0;

function formatCountdown(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

async function renderAlarmInfo() {
  const alarmInfo = document.getElementById("alarmInfo");
  const { enabled } = await chrome.storage.local.get("enabled");
  const alarm = await chrome.alarms.get("check-odyssey");

  if (enabled === false) {
    alarmInfo.textContent = `Auto-check: off - use "Check now" to check manually`;
    alarmInfo.classList.remove("error");
    return;
  }
  if (!alarm) {
    alarmInfo.textContent = `Auto-check: not scheduled (reload the extension)`;
    alarmInfo.classList.add("error");
    return;
  }
  alarmInfo.classList.remove("error");
  const secondsLeft = Math.max(0, Math.round((alarm.scheduledTime - Date.now()) / 1000));

  if (lastSecondsLeft !== null && lastSecondsLeft <= 2 && secondsLeft > lastSecondsLeft + 5) {
    justRefreshedUntil = Date.now() + 4000;
  }
  lastSecondsLeft = secondsLeft;

  const watchedCount = watchedFilms.length;
  const filmsNote = watchedCount > 0 ? ` (${watchedCount} film${watchedCount === 1 ? "" : "s"})` : " (nothing watched yet)";

  const countdown = formatCountdown(secondsLeft);
  if (Date.now() < justRefreshedUntil) {
    alarmInfo.textContent = `✓ Refreshed - next check in ${countdown}${filmsNote}`;
  } else {
    alarmInfo.textContent = `Auto-check: every ${alarm.periodInMinutes} min · next in ${countdown}${filmsNote}`;
  }
}

document.getElementById("prevPage")?.addEventListener("click", () => {
  currentPage = Math.max(1, currentPage - 1);
  renderList();
});

document.getElementById("nextPage")?.addEventListener("click", () => {
  currentPage += 1;
  renderList();
});

document.getElementById("checkNow")?.addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = "Checking…";
  document.getElementById("meta").textContent = "Checking…";
  try {
    await chrome.runtime.sendMessage({ type: "CHECK_NOW" });
  } catch (err) {
    document.getElementById("meta").textContent = "Couldn't reach the extension - reload it and try again";
  }
  currentPage = 1;
  await render();
  btn.disabled = false;
  btn.textContent = "Check now";
});

document.addEventListener("DOMContentLoaded", async () => {
  await render();
  sendMessageSafe({ type: "CHECK_NOW" });
  sendMessageSafe({ type: "CHECK_ALL_WATCHED" });
});
document.addEventListener("DOMContentLoaded", loadFilmDropdown);
window.addEventListener("pagehide", () => chrome.action.setBadgeText({ text: "" }));

setInterval(renderAlarmInfo, 1000);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.filmStates || changes.displayedFilm || changes.watchedFilms)) {
    render();
  }
});

if (chrome.tabs?.getCurrent) {
  chrome.tabs.getCurrent((tab) => {
    if (tab) {
      document.documentElement.classList.add("standalone");
      document.body.classList.add("standalone");
    }
  });
}
