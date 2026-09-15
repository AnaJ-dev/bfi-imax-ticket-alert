const HOME_URL = "https://whatson.bfi.org.uk/imax/Online/default.asp";
const ALARM_NAME = "check-odyssey";
// L6: kept in step with clampIntervalMinutes in shared.js. The service worker
// cannot load shared.js, so the rule is restated here and only here.
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 60;
const DEFAULT_INTERVAL_MINUTES = 5;

// L11: up to 30 routine lines per film per check drowned the console.error
// calls that matter. Routine logging is behind a flag; errors never are.
// Turn on from the service worker console: chrome.storage.local.set({ debug: true })
let debugLogging = false;
chrome.storage.local.get("debug").then(({ debug }) => (debugLogging = debug === true));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.debug) debugLogging = changes.debug.newValue === true;
});

function log(...args) {
  if (debugLogging) console.log(...args);
}

function clampIntervalMinutes(value) {
  // Number(null) is 0, which would clamp up to the 1-minute minimum - the most
  // aggressive setting. Treat null like undefined and use the default.
  if (value === null || value === undefined || value === "") return DEFAULT_INTERVAL_MINUTES;
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_MINUTES;
  return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(n)));
}
const MAX_PAGES = 30;

chrome.runtime.onInstalled.addListener(setupAlarm);
chrome.runtime.onStartup.addListener(setupAlarm);

chrome.notifications.onClicked.addListener(async (id) => {
  const { notificationMap = {} } = await chrome.storage.local.get("notificationMap");
  const entry = notificationMap[id];
  if (!entry) return;
  delete notificationMap[id];
  await chrome.storage.local.set({ notificationMap });
  chrome.notifications.clear(id);
  await clearUnseenAlerts();

  const film = { title: entry.title, permalink: entry.permalink };
  await setDisplayedFilm(film);
  await openScreening(film, { dateTime: entry.dateTime, page: entry.page });
});

// M4: entries used to be removed only on click. Most notifications are dismissed
// or hidden by the OS, so the map grew without a limit until storage filled up.
chrome.notifications.onClosed.addListener(async (id) => {
  const { notificationMap = {} } = await chrome.storage.local.get("notificationMap");
  if (!notificationMap[id]) return;
  delete notificationMap[id];
  await chrome.storage.local.set({ notificationMap });
});

const NOTIFICATION_MAP_TTL_MS = 24 * 60 * 60 * 1000;

function pruneNotificationMap(map) {
  const cutoff = Date.now() - NOTIFICATION_MAP_TTL_MS;
  for (const [id, entry] of Object.entries(map)) {
    // Entries written before this fix have no timestamp - drop them too.
    if (!entry.createdAt || entry.createdAt < cutoff) delete map[id];
  }
  return map;
}

async function setupAlarm() {
  const { enabled, intervalMinutes } = await chrome.storage.local.get(["enabled", "intervalMinutes"]);
  if (enabled === false) return;
  chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: clampIntervalMinutes(intervalMinutes ?? DEFAULT_INTERVAL_MINUTES),
  });
}

// H3: filmStates is read-modify-written as one object, so two checks running at
// the same time lose each other's writes. Everything that touches it goes
// through this single chain instead of running in parallel.
let queueTail = Promise.resolve();

function runQueued(task) {
  const run = queueTail.then(task);
  queueTail = run.catch(() => {});
  return run;
}

// Short lock for a single read-modify-write on storage. Kept separate from the
// check queue so a popup click never waits behind a multi-second check.
let stateLockTail = Promise.resolve();

function withStateLock(task) {
  const run = stateLockTail.then(task);
  stateLockTail = run.catch(() => {});
  return run;
}

async function checkAllWatched() {
  const films = await getWatchedFilms();
  let totalAlerts = 0;
  for (const film of films) {
    totalAlerts += (await checkOneFilm(film)) || 0;
  }
  if (totalAlerts > 0) await addUnseenAlerts(totalAlerts);
}

// M5: the badge used to show the count of the latest check only, so a later
// check of 2 replaced an earlier 5. It now accumulates until the user reads it.
function addUnseenAlerts(count) {
  return withStateLock(async () => {
    const { unseenAlerts = 0 } = await chrome.storage.local.get("unseenAlerts");
    const total = unseenAlerts + count;
    await chrome.storage.local.set({ unseenAlerts: total });
    chrome.action.setBadgeText({ text: String(total) });
    chrome.action.setBadgeBackgroundColor({ color: "#e53e3e" });
    return total;
  });
}

function clearUnseenAlerts() {
  return withStateLock(async () => {
    await chrome.storage.local.set({ unseenAlerts: 0 });
    chrome.action.setBadgeText({ text: "" });
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  (async () => {
    const { enabled } = await chrome.storage.local.get("enabled");
    if (enabled === false) return;
    await runQueued(checkAllWatched);
  })();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // L7: no effect today (no content scripts, no externally_connectable), but it
  // stops a web page reaching OPEN_SCREENING if either is ever added.
  if (sender.id !== chrome.runtime.id) return;

  if (msg.type === "CHECK_NOW") {
    runQueued(async () => {
      const film = await getDisplayedFilm();
      if (!film) return;
      const count = await checkOneFilm(film);
      if (count > 0) await addUnseenAlerts(count);
    })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (msg.type === "CHECK_ALL_WATCHED") {
    runQueued(checkAllWatched)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (msg.type === "GET_FILM_LIST") {
    fetchFilmList()
      .then((films) => {
        if (films.length) chrome.storage.local.set({ cachedFilmList: films });
        sendResponse({ films });
      })
      .catch((err) => sendResponse({ films: [], error: String(err) }));
    return true;
  }
  if (msg.type === "SET_FILM") {
    setDisplayedFilm(msg.film ?? null).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "GET_WATCHED_FILMS") {
    getWatchedFilms().then((films) => sendResponse({ films }));
    return true;
  }
  if (msg.type === "ADD_WATCH") {
    addWatch(msg.film).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "REMOVE_WATCH") {
    removeWatch(msg.permalink).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "OPEN_SCREENING") {
    getDisplayedFilm()
      .then((film) => (film ? openScreening(film, msg.screening, { focusOnFailure: false }) : { ok: false, reason: "no-film-selected" }))
      .then((result) => sendResponse(result));
    return true;
  }
  if (msg.type === "ALERTS_SEEN") {
    clearUnseenAlerts().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "GET_NOTIFICATION_PERMISSION") {
    chrome.notifications.getPermissionLevel((level) => sendResponse({ permissionLevel: level }));
    return true;
  }
  if (msg.type === "TEST_NOTIFICATION") {
    chrome.notifications.create(`bfi-test-${Date.now()}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon128.png"),
      title: "BFI IMAX Ticket Alert - test notification",
      message: "If you can see this, desktop notifications are working.",
      priority: 2,
    }, () => sendResponse({ ok: !chrome.runtime.lastError, error: chrome.runtime.lastError?.message }));
    return true;
  }
  if (msg.type === "SET_NOTIFY_SLOTS") {
    setFilmState(msg.permalink, { notifyDateTimes: msg.dateTimes || [] }).then(() => sendResponse({ ok: true }));
    return true;
  }
});

// M9: there is no hardcoded default film any more - a film run ends and the
// permalink dies. Fall back to the first film BFI is actually listing, and
// return null if even that is unavailable so the popup can prompt the user.
async function getDisplayedFilm() {
  const { displayedFilm, watchedFilm } = await chrome.storage.local.get(["displayedFilm", "watchedFilm"]);
  if (displayedFilm) return displayedFilm;

  // Only carry over a film the user had already chosen under the old key.
  // Otherwise return null: the popup shows a "Choose your movie" placeholder
  // rather than silently picking a film on the user's behalf.
  if (watchedFilm) {
    await chrome.storage.local.set({ displayedFilm: watchedFilm });
    return watchedFilm;
  }
  return null;
}

async function setDisplayedFilm(film) {
  // null clears the selection and puts the popup back on the placeholder.
  // The legacy single-film key goes too, or getDisplayedFilm would restore it.
  if (film === null) {
    await chrome.storage.local.remove(["displayedFilm", "watchedFilm"]);
    return;
  }
  if (!film?.permalink || !film?.title) return;
  await chrome.storage.local.set({ displayedFilm: film });
}

async function getWatchedFilms() {
  const { watchedFilms, watchedFilm } = await chrome.storage.local.get(["watchedFilms", "watchedFilm"]);
  if (watchedFilms) return watchedFilms;
  // Only migrate a film the user had already chosen under the old single-film key.
  const fallback = watchedFilm ? [watchedFilm] : [];
  await chrome.storage.local.set({ watchedFilms: fallback });
  return fallback;
}

function addWatch(film) {
  if (!film?.permalink || !film?.title) return Promise.resolve();
  return withStateLock(async () => {
    const films = await getWatchedFilms();
    if (films.some((f) => f.permalink === film.permalink)) return;
    await chrome.storage.local.set({ watchedFilms: [...films, film] });
  });
}

async function removeWatch(permalink) {
  await withStateLock(async () => {
    const films = await getWatchedFilms();
    await chrome.storage.local.set({ watchedFilms: films.filter((f) => f.permalink !== permalink) });
  });
  await setFilmState(permalink, { notifyDateTimes: [], alertedAvailable: {} });
}

async function getFilmState(permalink) {
  const { filmStates = {} } = await chrome.storage.local.get("filmStates");
  return filmStates[permalink] || {};
}

function setFilmState(permalink, patch) {
  return withStateLock(async () => {
    const { filmStates = {} } = await chrome.storage.local.get("filmStates");
    filmStates[permalink] = { ...(filmStates[permalink] || {}), ...patch };
    await chrome.storage.local.set({ filmStates });
    return filmStates[permalink];
  });
}

function filmUrl(permalink) {
  return `${HOME_URL}?BOparam::WScontent::loadArticle::permalink=${permalink}&BOparam::WScontent::loadArticle::context_id=`;
}

const FILM_LISTING_PERMALINKS = ["imax-new-releases", "special-screenings-events"];

async function fetchFilmList() {
  let films = await fetchFilmListOnce();
  if (films.length === 0) {
    log("BFI: film list came back empty, refreshing session via a window…");
    await refreshClearanceViaWindow(HOME_URL);
    films = await fetchFilmListOnce();
  }
  return films;
}

async function fetchFilmListOnce() {
  const seen = new Set();
  const films = [];

  for (const permalink of FILM_LISTING_PERMALINKS) {
    const res = await fetch(filmUrl(permalink), { credentials: "include" });
    if (res.status !== 200) continue;
    const html = await res.text();
    if (/enable javascript and cookies to continue|just a moment/i.test(html)) continue;

    const re = /<h3 class="Highlight__heading">([^<]+)<\/h3>[\s\S]{0,400}?permalink=([a-z0-9-]+)"/gi;
    let m;
    while ((m = re.exec(html))) {
      const p = m[2];
      if (seen.has(p)) continue;
      seen.add(p);
      films.push({ title: decodeHtmlEntities(m[1].trim()), permalink: p });
    }
  }
  return films;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&rsquo;/g, "’");
}

async function fetchPage(url) {
  const res = await fetch(url, { credentials: "include" });
  if (res.status !== 200) return null;
  const html = await res.text();
  if (/enable javascript and cookies to continue|just a moment/i.test(html)) return null;
  return parsePage(html);
}

function parsePage(html) {
  const idx = html.indexOf("searchResults :");
  const end = html.indexOf("searchLabels");
  const hasResultsBlock = idx !== -1 && end !== -1;
  const block = hasResultsBlock ? html.slice(idx, end) : "";

  const dateTimeRegex =
    /(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s+\d{1,2}\s+\w+\s+\d{4}\s+\d{2}:\d{2}/g;
  const screenings = [];
  let m;
  while ((m = dateTimeRegex.exec(block))) {
    const after = block.slice(m.index + m[0].length, m.index + m[0].length + 400);
    const tokenRegex = /,\s*"((?:[^"\\]|\\.)*)"/g;
    const tokens = [];
    let tm;
    while (tokens.length < 9 && (tm = tokenRegex.exec(after))) tokens.push(tm[1]);
    const availableNumber = parseInt(tokens[8], 10);
    screenings.push({
      dateTime: m[0],
      status: availableNumber > 0 ? "available" : "sold_out",
    });
  }

  if (!hasResultsBlock) {
    return { screenings: [], totalPages: 1, sToken: null, articleId: null };
  }

  const totalPagesMatch = html.match(/total_pages:\s*"(\d+)"/);
  const tokenMatch = html.match(/sToken=([^&"]+)/);
  const articleIdMatch = html.match(/articleId:\s*"([^"]+)"/);

  return {
    screenings,
    totalPages: totalPagesMatch ? parseInt(totalPagesMatch[1], 10) : 1,
    sToken: tokenMatch ? tokenMatch[1] : null,
    articleId: articleIdMatch ? articleIdMatch[1] : null,
  };
}

function pageUrl(sToken, articleId, page) {
  return (
    `https://whatson.bfi.org.uk/imax/Online/default.asp?sToken=${encodeURIComponent(sToken)}` +
    `&BOset::WScontent::SearchResultsInfo::current_page=${page}` +
    `&doWork::WScontent::getPage=&BOparam::WScontent::getPage::article_id=${articleId}`
  );
}

async function collectAllScreenings(url) {
  const first = await fetchPage(url);
  if (!first) return { screenings: null, blocked: true };

  const all = first.screenings.map((s) => ({ ...s, page: 1 }));
  log(`BFI: page 1 -> ${first.screenings.length} screenings, total_pages=${first.totalPages}`);

  const lastPage = Math.min(first.totalPages || 1, MAX_PAGES);
  if (first.sToken && first.articleId) {
    for (let page = 2; page <= lastPage; page++) {
      const parsed = await fetchPage(pageUrl(first.sToken, first.articleId, page));
      if (!parsed) return { screenings: null, blocked: true };
      log(`BFI: page ${page} -> ${parsed.screenings.length} screenings`);
      all.push(...parsed.screenings.map((s) => ({ ...s, page })));
    }
  }

  return { screenings: dedupe(all), blocked: false };
}

async function refreshClearanceViaWindow(url) {
  let windowId;
  try {
    const win = await chrome.windows.create({ url, type: "popup", state: "minimized", focused: false });
    windowId = win.id;
    await waitForTabComplete(win.tabs[0].id);
    await sleep(2500);
  } finally {
    if (windowId) await chrome.windows.remove(windowId).catch(() => {});
  }
}

async function checkOneFilm(film) {
  const watchedFilms = await getWatchedFilms();
  const isWatched = watchedFilms.some((f) => f.permalink === film.permalink);

  const url = filmUrl(film.permalink);

  try {
    let { screenings, blocked } = await collectAllScreenings(url);

    if (blocked) {
      log("BFI: fetch blocked by Cloudflare, refreshing session via a window…");
      await refreshClearanceViaWindow(url);
      ({ screenings, blocked } = await collectAllScreenings(url));
    }

    if (blocked || !screenings) {
      throw new Error("BFI page could not be loaded even after refreshing the session");
    }

    await setFilmState(film.permalink, { lastCheck: Date.now(), lastError: null, lastScreenings: screenings });

    if (!isWatched) return 0;

    if (await retireIfFinished(film, screenings)) return 0;

    const state = await getFilmState(film.permalink);
    const alertedAvailable = state.alertedAvailable || {};
    const notifyDateTimes = state.notifyDateTimes || [];
    const newlyAvailable = [];
    for (const s of screenings) {
      const wanted = notifyDateTimes.length === 0 || notifyDateTimes.includes(s.dateTime);
      if (s.status === "available" && wanted && !alertedAvailable[s.dateTime]) {
        newlyAvailable.push(s);
        alertedAvailable[s.dateTime] = true;
      } else if (s.status === "sold_out" && alertedAvailable[s.dateTime]) {
        delete alertedAvailable[s.dateTime];
      }
    }
    // L3: a past screening never reappears as sold_out, so its key would live
    // for ever. Keep only keys still present in the current listing.
    const live = new Set(screenings.map((s) => s.dateTime));
    for (const key of Object.keys(alertedAvailable)) {
      if (!live.has(key)) delete alertedAvailable[key];
    }
    await setFilmState(film.permalink, { alertedAvailable });

    if (newlyAvailable.length > 0) {
      const { desktopNotifications } = await chrome.storage.local.get("desktopNotifications");
      if (desktopNotifications !== false) {
        // M6: BFI can release a whole run at once. One notification per screening
        // gets rate-limited or collapsed by the OS, so the user sees none of them.
        if (newlyAvailable.length === 1) {
          await notify(film, newlyAvailable[0]);
        } else {
          await notifyBatch(film, newlyAvailable);
        }
      }
    }

    return newlyAvailable.length;
  } catch (err) {
    console.error("BFI check failed for", film.title, err);
    await setFilmState(film.permalink, { lastCheck: Date.now(), lastError: String(err) });
    return 0;
  }
}

// L2: nothing ever removed a film, so a finished run kept costing up to 30
// fetches a minute for ever - raising the Cloudflare risk for films the user
// still wants. A film is retired when its whole run is in the past, or when BFI
// has listed nothing for it for 7 days.
const DEAD_FILM_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
// A film BFI has never listed is one the user is waiting to be announced, which
// can take many months - but not for ever. Give up after 300 days.
const UNANNOUNCED_MAX_MS = 300 * 24 * 60 * 60 * 1000;
const MAX_RETIRED_RECORDS = 10;

function parseScreeningDate(dateTime) {
  return new Date(String(dateTime).replace(/^\w+\s+/, ""));
}

function allScreeningsPast(screenings) {
  if (!screenings.length) return false;
  const now = Date.now();
  return screenings.every((s) => {
    const t = parseScreeningDate(s.dateTime).getTime();
    return Number.isFinite(t) && t < now;
  });
}

async function retireIfFinished(film, screenings) {
  const state = await getFilmState(film.permalink);

  if (screenings.length === 0) {
    const emptySince = state.emptySince || Date.now();
    if (!state.emptySince) await setFilmState(film.permalink, { emptySince });

    // A film BFI has never listed is one the user is WAITING for - the popup
    // promises to tell them the moment dates are announced, and that can be
    // months away. It gets 300 days, not the 7 given to a film whose run ended.
    const grace = state.everHadScreenings ? DEAD_FILM_GRACE_MS : UNANNOUNCED_MAX_MS;
    if (Date.now() - emptySince < grace) return false;

    await removeWatch(film.permalink);
    await recordRetiredFilm(film, state.everHadScreenings ? "no-listings" : "never-announced");
    return true;
  }

  if (!state.everHadScreenings || state.emptySince) {
    await setFilmState(film.permalink, { everHadScreenings: true, emptySince: null });
  }

  if (!allScreeningsPast(screenings)) {
    if (state.allPastSince) await setFilmState(film.permalink, { allPastSince: null });
    return false;
  }

  // One bad response - a stale or partial page listing only old dates - must not
  // unfollow a film on its own. Require two consecutive checks to agree.
  if (!state.allPastSince) {
    await setFilmState(film.permalink, { allPastSince: Date.now() });
    return false;
  }

  await removeWatch(film.permalink);
  await recordRetiredFilm(film, "run-ended");
  return true;
}

function recordRetiredFilm(film, reason) {
  return withStateLock(async () => {
    const { retiredFilms = [] } = await chrome.storage.local.get("retiredFilms");
    if (retiredFilms.some((f) => f.permalink === film.permalink)) return;
    retiredFilms.push({ title: film.title, permalink: film.permalink, reason, at: Date.now() });
    await chrome.storage.local.set({ retiredFilms: retiredFilms.slice(-MAX_RETIRED_RECORDS) });
  });
}

// M12: the page number stored at check time goes stale - screenings sell out and
// dates pass, so BFI shuffles them between pages. The target page is resolved
// again here, using the stored number only as a hint.
// M13: resolving before the tab opens means one page load instead of two.
async function resolveScreeningUrl(url, dateTime, hintPage) {
  const first = await fetchPage(url);
  if (!first) return null; // Cloudflare challenge - caller retries after a real tab load.

  const holds = (parsed) => parsed?.screenings?.some((s) => s.dateTime === dateTime);
  if (holds(first)) return url;
  if (!first.sToken || !first.articleId) return null;

  const lastPage = Math.min(first.totalPages || 1, MAX_PAGES);
  const pagesToTry = [];
  if (hintPage > 1 && hintPage <= lastPage) pagesToTry.push(hintPage);
  for (let page = 2; page <= lastPage; page++) {
    if (page !== hintPage) pagesToTry.push(page);
  }

  for (const page of pagesToTry) {
    const candidate = pageUrl(first.sToken, first.articleId, page);
    const parsed = await fetchPage(candidate);
    if (!parsed) return null;
    if (holds(parsed)) return candidate;
  }
  return null;
}

async function openBookingWindow(film, screening) {
  const url = filmUrl(film.permalink);

  // A background fetch cannot solve a Cloudflare challenge, so this can come
  // back null. The tab load below refreshes the clearance cookie; we retry once
  // afterwards and navigate, which is the old two-load path kept as a fallback.
  let target = await resolveScreeningUrl(url, screening.dateTime, screening.page);

  // H6: created in the background. An active tab steals focus, which closes the
  // popup before it can read the result of the handoff. The tab is brought
  // forward in openScreening once the Buy click has succeeded.
  const tab = await chrome.tabs.create({ url: target || url, active: false });
  const tabId = tab.id;
  if ((await waitForTabComplete(tabId)) === "removed") throw new Error("tab-closed");
  await sleep(1500);
  const banner = await chrome.scripting
    .executeScript({ target: { tabId }, func: dismissCookieBanner })
    .then(([r]) => r?.result)
    .catch(() => null);
  if (banner) {
    await chrome.storage.local.set({
      lastCookieBanner: { ...banner, at: Date.now(), url: tab.url || url },
    });
  }

  if (!target) {
    target = await resolveScreeningUrl(url, screening.dateTime, screening.page);
    if (target && target !== url) {
      await chrome.tabs.update(tabId, { url: target });
      if ((await waitForTabComplete(tabId)) === "removed") throw new Error("tab-closed");
      await sleep(800);
    }
  }

  return tabId;
}

// focusOnFailure: true when nothing is listening for the result (a notification
// click), so the tab is shown even if the Buy link was not found. The popup
// passes false and reports the reason itself instead.
async function openScreening(film, screening, { focusOnFailure = true } = {}) {
  let tabId;
  try {
    tabId = await openBookingWindow(film, screening);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: clickBuyInPage,
      args: [screening.dateTime],
    });
    const outcome = result || { ok: false, reason: "unknown" };
    if (outcome.ok || focusOnFailure) await focusTab(tabId);
    return outcome;
  } catch (err) {
    if (!String(err).includes("No tab with id")) console.error("openScreening failed", err);
    if (tabId && focusOnFailure) await focusTab(tabId);
    return { ok: false, reason: String(err) };
  }
}

async function focusTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
  } catch (err) {
    // Tab closed by the user while the handoff was running - nothing to focus.
  }
}

function dedupe(screenings) {
  const seen = new Map();
  for (const s of screenings) {
    if (!seen.has(s.dateTime)) seen.set(s.dateTime, s);
  }
  return Array.from(seen.values());
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// M3: resolves with a reason instead of hanging for ever. A never-settling await
// here used to skip the `finally` in refreshClearanceViaWindow and leak a
// minimized window on the every-minute check path.
const TAB_LOAD_TIMEOUT_MS = 12000;

function waitForTabComplete(tabId, timeoutMs = TAB_LOAD_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve(reason);
    };

    function onUpdated(id, info) {
      if (id === tabId && info.status === "complete") finish("complete");
    }
    function onRemoved(id) {
      if (id === tabId) finish("removed");
    }

    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    // A cached page can reach "complete" before the listener is attached.
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) finish("removed");
      else if (tab?.status === "complete") finish("complete");
    });
  });
}

async function notify(film, screening) {
  const id = `bfi-catch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const { notificationMap = {} } = await chrome.storage.local.get("notificationMap");
  pruneNotificationMap(notificationMap);
  notificationMap[id] = {
    permalink: film.permalink,
    title: film.title,
    dateTime: screening.dateTime,
    page: screening.page,
    createdAt: Date.now(),
  };
  await chrome.storage.local.set({ notificationMap });

  return new Promise((resolve) => {
    chrome.notifications.create(
      id,
      {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icon128.png"),
        title: `${film.title} - seats just opened!`,
        message: `${screening.dateTime} is now bookable at BFI IMAX. Go, go, go!`,
        priority: 2,
      },
      (createdId) => {
        if (chrome.runtime.lastError) {
          console.error("notifications.create failed:", chrome.runtime.lastError.message);
          resolve({ ok: false, reason: chrome.runtime.lastError.message });
        } else {
          resolve({ ok: true, id: createdId });
        }
      }
    );
  });
}

async function notifyBatch(film, screenings) {
  const id = `bfi-catch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const first = screenings[0];
  const { notificationMap = {} } = await chrome.storage.local.get("notificationMap");
  pruneNotificationMap(notificationMap);
  notificationMap[id] = {
    permalink: film.permalink,
    title: film.title,
    dateTime: first.dateTime,
    page: first.page,
    createdAt: Date.now(),
  };
  await chrome.storage.local.set({ notificationMap });

  return new Promise((resolve) => {
    chrome.notifications.create(
      id,
      {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icon128.png"),
        title: `${film.title} - ${screenings.length} new times available!`,
        message: `Earliest: ${first.dateTime}. Open the extension to see all ${screenings.length}.`,
        priority: 2,
      },
      (createdId) => {
        if (chrome.runtime.lastError) {
          console.error("notifications.create failed:", chrome.runtime.lastError.message);
          resolve({ ok: false, reason: chrome.runtime.lastError.message });
        } else {
          resolve({ ok: true, id: createdId });
        }
      }
    );
  });
}

function dismissCookieBanner() {
  const candidates = Array.from(document.querySelectorAll("button, a"));
  const match = (re) => candidates.find((el) => re.test(el.textContent.trim()));
  // Reject options first. "accept cookies" stays last only so a banner with no
  // reject button still gets cleared - it can cover the Buy link.
  const btn =
    match(/continue without accepting/i) ||
    match(/reject all|decline all/i) ||
    match(/only necessary|necessary cookies only|essential cookies only/i) ||
    match(/^reject|^decline/i) ||
    match(/accept cookies/i);

  // Name every button on the banner and the one chosen, so the choice can be
  // checked afterwards - the click itself is far too fast to watch.
  const offered = candidates
    .map((el) => el.textContent.trim())
    .filter((txt) => txt && txt.length < 60 && /cookie|accept|reject|decline|consent|necessary/i.test(txt));

  if (!btn) {
    console.log("[BFI Ticket Alert] No cookie banner button found.");
    return { clicked: null, offered };
  }

  const clicked = btn.textContent.trim();
  btn.click();
  console.log(`[BFI Ticket Alert] Cookie banner: clicked "${clicked}". Buttons offered:`, offered);
  return { clicked, offered };
}

function clickBuyInPage(targetDateTime) {
  const links = Array.from(document.querySelectorAll("a"));
  const buyLink = links.find(
    (a) => /buy/i.test(a.textContent) && a.getAttribute("aria-label")?.includes(targetDateTime)
  );
  if (!buyLink) return { ok: false, reason: "buy-link-not-found" };
  buyLink.click();
  return { ok: true };
}

