const HOME_URL = "https://whatson.bfi.org.uk/imax/Online/default.asp";
const DEFAULT_FILM = { title: "The Odyssey", permalink: "odyssey-the-film-imax-70mm-2026" };

const ALARM_NAME = "check-odyssey";
const DEFAULT_INTERVAL_MINUTES = 1;
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
  chrome.action.setBadgeText({ text: "" });

  const film = { title: entry.title, permalink: entry.permalink };
  await setDisplayedFilm(film);
  await openScreening(film, { dateTime: entry.dateTime, page: entry.page });
});

async function setupAlarm() {
  const { enabled, intervalMinutes } = await chrome.storage.local.get(["enabled", "intervalMinutes"]);
  if (enabled === false) return;
  chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: intervalMinutes || DEFAULT_INTERVAL_MINUTES,
  });
}

async function checkAllWatched() {
  const films = await getWatchedFilms();
  let totalAlerts = 0;
  for (const film of films) {
    totalAlerts += (await checkOneFilm(film)) || 0;
  }
  if (totalAlerts > 0) {
    chrome.action.setBadgeText({ text: String(totalAlerts) });
    chrome.action.setBadgeBackgroundColor({ color: "#e53e3e" });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  (async () => {
    const { enabled } = await chrome.storage.local.get("enabled");
    if (enabled === false) return;
    await checkAllWatched();
  })();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "CHECK_NOW") {
    getDisplayedFilm()
      .then(async (film) => {
        const count = await checkOneFilm(film);
        if (count > 0) {
          chrome.action.setBadgeText({ text: String(count) });
          chrome.action.setBadgeBackgroundColor({ color: "#e53e3e" });
        }
        sendResponse({ ok: true });
      });
    return true;
  }
  if (msg.type === "CHECK_ALL_WATCHED") {
    checkAllWatched().then(() => sendResponse({ ok: true }));
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
    setDisplayedFilm(msg.film).then(() => sendResponse({ ok: true }));
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
    getDisplayedFilm().then((film) => openScreening(film, msg.screening)).then((result) => sendResponse(result));
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
      title: "BFI Movie Catcher - test notification",
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

async function getDisplayedFilm() {
  const { displayedFilm, watchedFilm } = await chrome.storage.local.get(["displayedFilm", "watchedFilm"]);
  if (displayedFilm) return displayedFilm;
  const fallback = watchedFilm || DEFAULT_FILM;
  await chrome.storage.local.set({ displayedFilm: fallback });
  return fallback;
}

async function setDisplayedFilm(film) {
  if (!film?.permalink || !film?.title) return;
  await chrome.storage.local.set({ displayedFilm: film });
}

async function getWatchedFilms() {
  const { watchedFilms, watchedFilm } = await chrome.storage.local.get(["watchedFilms", "watchedFilm"]);
  if (watchedFilms) return watchedFilms;
  const fallback = [watchedFilm || DEFAULT_FILM];
  await chrome.storage.local.set({ watchedFilms: fallback });
  return fallback;
}

async function addWatch(film) {
  if (!film?.permalink || !film?.title) return;
  const films = await getWatchedFilms();
  if (films.some((f) => f.permalink === film.permalink)) return;
  await chrome.storage.local.set({ watchedFilms: [...films, film] });
}

async function removeWatch(permalink) {
  const films = await getWatchedFilms();
  await chrome.storage.local.set({ watchedFilms: films.filter((f) => f.permalink !== permalink) });
  await setFilmState(permalink, { notifyDateTimes: [], alertedAvailable: {} });
}

async function getFilmState(permalink) {
  const { filmStates = {} } = await chrome.storage.local.get("filmStates");
  return filmStates[permalink] || {};
}

async function setFilmState(permalink, patch) {
  const { filmStates = {} } = await chrome.storage.local.get("filmStates");
  filmStates[permalink] = { ...(filmStates[permalink] || {}), ...patch };
  await chrome.storage.local.set({ filmStates });
  return filmStates[permalink];
}

function filmUrl(permalink) {
  return `${HOME_URL}?BOparam::WScontent::loadArticle::permalink=${permalink}&BOparam::WScontent::loadArticle::context_id=`;
}

const FILM_LISTING_PERMALINKS = ["imax-new-releases", "special-screenings-events"];

async function fetchFilmList() {
  let films = await fetchFilmListOnce();
  if (films.length === 0) {
    console.log("BFI: film list came back empty, refreshing session via a window…");
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
  console.log(`BFI: page 1 -> ${first.screenings.length} screenings, total_pages=${first.totalPages}`);

  const lastPage = Math.min(first.totalPages || 1, MAX_PAGES);
  if (first.sToken && first.articleId) {
    for (let page = 2; page <= lastPage; page++) {
      const parsed = await fetchPage(pageUrl(first.sToken, first.articleId, page));
      if (!parsed) return { screenings: null, blocked: true };
      console.log(`BFI: page ${page} -> ${parsed.screenings.length} screenings`);
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
      console.log("BFI: fetch blocked by Cloudflare, refreshing session via a window…");
      await refreshClearanceViaWindow(url);
      ({ screenings, blocked } = await collectAllScreenings(url));
    }

    if (blocked || !screenings) {
      throw new Error("BFI page could not be loaded even after refreshing the session");
    }

    await setFilmState(film.permalink, { lastCheck: Date.now(), lastError: null, lastScreenings: screenings });

    if (!isWatched) return 0;

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
    await setFilmState(film.permalink, { alertedAvailable });

    if (newlyAvailable.length > 0) {
      const { desktopNotifications } = await chrome.storage.local.get("desktopNotifications");
      if (desktopNotifications !== false) {
        for (const s of newlyAvailable) await notify(film, s);
      }
    }

    return newlyAvailable.length;
  } catch (err) {
    console.error("BFI check failed for", film.title, err);
    await setFilmState(film.permalink, { lastCheck: Date.now(), lastError: String(err) });
    return 0;
  }
}

async function openBookingWindow(film, screening, { asTab = false } = {}) {
  const url = filmUrl(film.permalink);
  let tabId;
  if (asTab) {
    const tab = await chrome.tabs.create({ url, active: true });
    tabId = tab.id;
  } else {
    const win = await chrome.windows.create({ url, type: "normal", state: "normal", focused: true });
    tabId = win.tabs[0].id;
  }
  await waitForTabComplete(tabId);
  await sleep(1500);
  await chrome.scripting.executeScript({ target: { tabId }, func: dismissCookieBanner }).catch(() => {});

  if (screening.page && screening.page > 1) {
    const first = await fetchPage(url);
    if (first?.sToken && first?.articleId) {
      await chrome.tabs.update(tabId, { url: pageUrl(first.sToken, first.articleId, screening.page) });
      await waitForTabComplete(tabId);
      await sleep(800);
    }
  }

  return tabId;
}

async function openScreening(film, screening) {
  try {
    const tabId = await openBookingWindow(film, screening, { asTab: true });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: clickBuyInPage,
      args: [screening.dateTime],
    });
    return result || { ok: false, reason: "unknown" };
  } catch (err) {
    if (!String(err).includes("No tab with id")) console.error("openScreening failed", err);
    return { ok: false, reason: String(err) };
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

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function notify(film, screening) {
  const id = `bfi-catch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const { notificationMap = {} } = await chrome.storage.local.get("notificationMap");
  notificationMap[id] = { permalink: film.permalink, title: film.title, dateTime: screening.dateTime, page: screening.page };
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

function dismissCookieBanner() {
  const candidates = Array.from(document.querySelectorAll("button, a"));
  const btn =
    candidates.find((el) => /accept cookies/i.test(el.textContent)) ||
    candidates.find((el) => /continue without accepting/i.test(el.textContent));
  if (btn) btn.click();
  return !!btn;
}

function clickBuyInPage(targetDateTime) {
  const links = Array.from(document.querySelectorAll("a"));
  const buyLink =
    links.find((a) => /buy/i.test(a.textContent) && a.getAttribute("aria-label")?.includes(targetDateTime)) ||
    links.find((a) => a.textContent.trim().toLowerCase() === "buy");
  if (!buyLink) return { ok: false, reason: "buy-link-not-found" };
  buyLink.click();
  return { ok: true };
}

