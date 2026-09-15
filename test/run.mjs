import fs from "fs";
import { makeChrome, bfiHtml } from "./fakechrome.mjs";

const SRC = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");
const EXPORTS = `
return { checkAllWatched, checkOneFilm, getWatchedFilms, getDisplayedFilm, setDisplayedFilm,
         addWatch, removeWatch, getFilmState, setFilmState, addUnseenAlerts, clearUnseenAlerts,
         notify, notifyBatch, pruneNotificationMap, openScreening, openBookingWindow,
         resolveScreeningUrl, retireIfFinished, allScreeningsPast, setupAlarm,
         clampIntervalMinutes, collectAllScreenings, parsePage };`;

// Boot a fresh copy of background.js against a fresh fake Chrome.
function boot(fetchImpl) {
  const env = makeChrome();
  const fn = new Function("chrome", "fetch", "console", "setTimeout", "clearTimeout", SRC + EXPORTS);
  const api = fn(env.chrome, fetchImpl, { log(){}, error(){}, warn(){} }, setTimeout, clearTimeout);
  return { ...env, api };
}

const ok = (html, status = 200) => ({ status, text: async () => html });
const notFound = { status: 403, text: async () => "just a moment" };

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log("  \x1b[32mPASS\x1b[0m", name); }
  else { fail++; console.log("  \x1b[31mFAIL\x1b[0m", name, extra !== undefined ? "\n        got: " + JSON.stringify(extra) : ""); }
};
const section = (s) => console.log("\n\x1b[1m" + s + "\x1b[0m");

const future = (d) => {
  const dt = new Date(Date.now() + d * 864e5);
  const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const mon = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${days[dt.getDay()]} ${dt.getDate()} ${mon[dt.getMonth()]} ${dt.getFullYear()} 19:00`;
};
const past = (d) => future(-d);

// ---------------------------------------------------------------- M9
section("M9 — no film is watched or displayed by default");
{
  const env = boot(async () => ok(bfiHtml([])));
  t("new install watches nothing", JSON.stringify(await env.api.getWatchedFilms()) === "[]");
  t("new install displays nothing", (await env.api.getDisplayedFilm()) === null);
  t("no film written to storage", env.store.displayedFilm === undefined);

  // legacy single-film user must still migrate
  const env2 = boot(async () => ok(bfiHtml([])));
  await env2.chrome.storage.local.set({ watchedFilm: { title: "Old", permalink: "old" } });
  t("legacy watchedFilm migrates", (await env2.api.getWatchedFilms())[0].permalink === "old");
  t("legacy film is displayed", (await env2.api.getDisplayedFilm()).permalink === "old");
}

section("M9 — selecting the placeholder clears the film");
{
  const env = boot(async () => ok(bfiHtml([])));
  await env.api.setDisplayedFilm({ title: "Digger", permalink: "digger" });
  t("film set", env.store.displayedFilm.permalink === "digger");
  await env.fire.message({ type: "SET_FILM", film: null });
  t("SET_FILM null clears it", env.store.displayedFilm === undefined);
  t("still cleared on re-read", (await env.api.getDisplayedFilm()) === null);
}

// ---------------------------------------------------------------- M5
section("M5 — badge accumulates and clears only on view");
{
  const env = boot(async () => ok(bfiHtml([])));
  await env.api.addUnseenAlerts(3);
  await env.api.addUnseenAlerts(2);
  t("badge shows the running total, not the latest", env.log.badge.at(-1) === "5", env.log.badge);
  t("total persisted", env.store.unseenAlerts === 5);
  await env.fire.message({ type: "ALERTS_SEEN" });
  t("ALERTS_SEEN clears the badge", env.log.badge.at(-1) === "");
  t("counter reset", env.store.unseenAlerts === 0);
}

// ---------------------------------------------------------------- M4
section("M4 — notification map does not grow without limit");
{
  const env = boot(async () => ok(bfiHtml([])));
  const film = { title: "F", permalink: "f" };
  await env.api.notify(film, { dateTime: future(3), page: 1 });
  const id = Object.keys(env.store.notificationMap)[0];
  t("entry created with a timestamp", !!env.store.notificationMap[id].createdAt);
  await env.fire.notificationClosed(id);
  t("dismissing removes the entry", Object.keys(env.store.notificationMap).length === 0);

  // stale + legacy entries are pruned on the next notify
  await env.chrome.storage.local.set({ notificationMap: {
    stale: { createdAt: Date.now() - 25 * 3600e3 },
    legacy: { permalink: "x" },
    fresh: { createdAt: Date.now() },
  }});
  await env.api.notify(film, { dateTime: future(4), page: 1 });
  const keys = Object.keys(env.store.notificationMap);
  t("24h-old entry pruned", !keys.includes("stale"));
  t("untimestamped legacy entry pruned", !keys.includes("legacy"));
  t("fresh entry kept", keys.includes("fresh"));
}

// ---------------------------------------------------------------- M6
section("M6 — a batch of new screenings is one notification");
{
  const env = boot(async () => ok(bfiHtml([])));
  await env.api.notifyBatch({ title: "Digger", permalink: "d" },
    [{ dateTime: future(2), page: 1 }, { dateTime: future(3), page: 1 }, { dateTime: future(4), page: 2 }]);
  t("exactly one notification", env.log.notifications.length === 1, env.log.notifications.length);
  t("it names the count", /3 new times available/.test(env.log.notifications[0].title), env.log.notifications[0].title);
  const entry = Object.values(env.store.notificationMap)[0];
  t("click target is the earliest screening", entry.dateTime === future(2));
}

// ---------------------------------------------------------------- H3
section("H3 — concurrent checks do not duplicate alerts or lose settings");
{
  const screenings = [{ dateTime: future(5), seats: 4 }, { dateTime: future(6), seats: 2 }];
  const env = boot(async () => ok(bfiHtml(screenings)));
  const film = { title: "Digger", permalink: "digger" };
  await env.api.addWatch(film);
  await env.api.setDisplayedFilm(film);

  // the popup's two messages, fired the way the popup fires them
  await Promise.all([
    env.fire.message({ type: "CHECK_NOW" }),
    env.fire.message({ type: "CHECK_ALL_WATCHED" }),
  ]);
  // 2 new screenings batch into 1 notification (M6). The duplicate bug would
  // show up as 2 identical batches from the two parallel checks.
  t("parallel checks of the same film alert ONCE", env.log.notifications.length === 1, env.log.notifications.length);

  // and the single-screening case, where a duplicate is unmistakable
  const envS = boot(async () => ok(bfiHtml([{ dateTime: future(5), seats: 4 }])));
  await envS.api.addWatch(film);
  await envS.api.setDisplayedFilm(film);
  await Promise.all([
    envS.fire.message({ type: "CHECK_NOW" }),
    envS.fire.message({ type: "CHECK_ALL_WATCHED" }),
    envS.fire.alarm("check-odyssey"),
  ]);
  t("one screening + three concurrent checks -> exactly one alert", envS.log.notifications.length === 1, envS.log.notifications.length);

  // a settings write racing a check must survive
  const env2 = boot(async () => ok(bfiHtml(screenings)));
  await env2.api.addWatch(film);
  await env2.api.setDisplayedFilm(film);
  await Promise.all([
    env2.fire.message({ type: "CHECK_ALL_WATCHED" }),
    env2.fire.message({ type: "SET_NOTIFY_SLOTS", permalink: "digger", dateTimes: [future(5)] }),
    env2.fire.message({ type: "CHECK_NOW" }),
  ]);
  const slots = env2.store.filmStates.digger.notifyDateTimes;
  t("the bell setting is not lost to a racing check", JSON.stringify(slots) === JSON.stringify([future(5)]), slots);
}

// ---------------------------------------------------------------- L3
section("L3 — alert keys for vanished screenings are pruned");
{
  let current = [{ dateTime: future(5), seats: 3 }, { dateTime: future(6), seats: 3 }];
  const env = boot(async () => ok(bfiHtml(current)));
  const film = { title: "D", permalink: "d" };
  await env.api.addWatch(film);
  await env.api.checkOneFilm(film);
  t("both screenings recorded as alerted", Object.keys(env.store.filmStates.d.alertedAvailable).length === 2);

  current = [{ dateTime: future(6), seats: 3 }];   // the first one has now passed
  await env.api.checkOneFilm(film);
  const keys = Object.keys(env.store.filmStates.d.alertedAvailable);
  t("the vanished screening's key is dropped", keys.length === 1 && keys[0] === future(6), keys);
}

// ---------------------------------------------------------------- L2
section("L2 — a finished film retires itself");
{
  const env = boot(async () => ok(bfiHtml([{ dateTime: past(3), seats: 0 }])));
  const film = { title: "Done", permalink: "done" };
  await env.api.addWatch(film);
  await env.api.checkOneFilm(film);
  await env.api.checkOneFilm(film);
  t("whole run in the past -> unwatched", JSON.stringify(await env.api.getWatchedFilms()) === "[]");
  t("the user is told", env.store.retiredFilms?.[0]?.reason === "run-ended", env.store.retiredFilms);

  // a live run must NOT be retired
  const env2 = boot(async () => ok(bfiHtml([{ dateTime: past(3), seats: 0 }, { dateTime: future(9), seats: 2 }])));
  await env2.api.addWatch({ title: "Live", permalink: "live" });
  await env2.api.checkOneFilm({ title: "Live", permalink: "live" });
  t("a run with a future date is kept", (await env2.api.getWatchedFilms()).length === 1);

  // empty listing: kept for 7 days, then retired
  const env3 = boot(async () => ok(bfiHtml([])));
  await env3.api.addWatch({ title: "Empty", permalink: "empty" });
  await env3.api.checkOneFilm({ title: "Empty", permalink: "empty" });
  t("empty listing is kept at first", (await env3.api.getWatchedFilms()).length === 1);
  // it must have HAD dates before the empty clock can apply
  const fs3 = env3.store.filmStates;
  fs3.empty.everHadScreenings = true;
  fs3.empty.emptySince = Date.now() - 8 * 864e5;
  await env3.chrome.storage.local.set({ filmStates: fs3 });
  await env3.api.checkOneFilm({ title: "Empty", permalink: "empty" });
  t("empty for 8 days after having dates -> retired", (await env3.api.getWatchedFilms()).length === 0);
}

// ---------------------------------------------------------------- L6
section("L2 — an UNANNOUNCED film is never retired");
{
  // The popup promises to tell the user the moment BFI announces dates.
  const env = boot(async () => ok(bfiHtml([])));
  const film = { title: "Digger", permalink: "digger" };
  await env.api.addWatch(film);
  await env.api.checkOneFilm(film);
  t("still watched after the first empty check", (await env.api.getWatchedFilms()).length === 1);

  // ...far past the 7-day grace that applies to a film whose run has ended
  const fs = env.store.filmStates;
  fs.digger.emptySince = Date.now() - 200 * 864e5;
  await env.chrome.storage.local.set({ filmStates: fs });
  await env.api.checkOneFilm(film);
  t("still watched after 200 days of no listings", (await env.api.getWatchedFilms()).length === 1);
  t("no retirement notice shown", !env.store.retiredFilms);

  // just under the 300-day cap
  fs.digger.emptySince = Date.now() - 299 * 864e5;
  await env.chrome.storage.local.set({ filmStates: fs });
  await env.api.checkOneFilm(film);
  t("still watched at 299 days", (await env.api.getWatchedFilms()).length === 1);

  // past it
  fs.digger.emptySince = Date.now() - 301 * 864e5;
  await env.chrome.storage.local.set({ filmStates: fs });
  await env.api.checkOneFilm(film);
  t("retired at 301 days", (await env.api.getWatchedFilms()).length === 0);
  t("reported as never-announced", env.store.retiredFilms[0].reason === "never-announced");
}

section("L2 — the 7-day clock applies only AFTER a film has had dates");
{
  let listing = [{ dateTime: future(20), seats: 3 }];
  const env = boot(async () => ok(bfiHtml(listing)));
  const film = { title: "Ran", permalink: "ran" };
  await env.api.addWatch(film);
  await env.api.checkOneFilm(film);
  t("a listed film is marked as having had dates", env.store.filmStates.ran.everHadScreenings === true);

  listing = [];                                   // BFI pulls the listing
  await env.api.checkOneFilm(film);
  t("kept during the grace period", (await env.api.getWatchedFilms()).length === 1);

  const fs = env.store.filmStates;
  fs.ran.emptySince = Date.now() - 8 * 864e5;
  await env.chrome.storage.local.set({ filmStates: fs });
  await env.api.checkOneFilm(film);
  t("retired once the grace period expires", (await env.api.getWatchedFilms()).length === 0);
}

section("L2 — one bad page cannot unfollow a film");
{
  let listing = [{ dateTime: past(2), seats: 0 }];
  const env = boot(async () => ok(bfiHtml(listing)));
  const film = { title: "Glitch", permalink: "glitch" };
  await env.api.addWatch(film);
  await env.api.checkOneFilm(film);
  t("first all-past check does NOT unfollow", (await env.api.getWatchedFilms()).length === 1);

  // the listing recovers - it was a glitch
  listing = [{ dateTime: future(10), seats: 2 }];
  await env.api.checkOneFilm(film);
  t("a recovered listing clears the strike", !env.store.filmStates.glitch.allPastSince);
  t("and the film is still watched", (await env.api.getWatchedFilms()).length === 1);

  // genuinely finished: two all-past checks in a row
  listing = [{ dateTime: past(2), seats: 0 }];
  await env.api.checkOneFilm(film);
  await env.api.checkOneFilm(film);
  t("two all-past checks in a row DO retire it", (await env.api.getWatchedFilms()).length === 0);
  t("reported as run-ended", env.store.retiredFilms[0].reason === "run-ended");
}

section("L6 — the alarm interval is clamped");
{
  const env = boot(async () => ok(bfiHtml([])));
  await env.chrome.storage.local.set({ intervalMinutes: 999 });
  await env.api.setupAlarm();
  t("999 clamps to 60", (await env.chrome.alarms.getAll())[0].periodInMinutes === 60);
  await env.chrome.storage.local.set({ intervalMinutes: null });
  await env.api.setupAlarm();
  t("null falls back to 5, not 1", (await env.chrome.alarms.getAll())[0].periodInMinutes === 5);
  const env2 = boot(async () => ok(bfiHtml([])));
  await env2.api.setupAlarm();
  t("fresh install defaults to 5", (await env2.chrome.alarms.getAll())[0].periodInMinutes === 5);
}

// ---------------------------------------------------------------- L7
section("L7 — messages from outside the extension are refused");
{
  const env = boot(async () => ok(bfiHtml([])));
  await env.api.setDisplayedFilm({ title: "D", permalink: "d" });
  const reply = await env.fire.message({ type: "SET_FILM", film: null }, { id: "some-other-extension" });
  t("a foreign sender gets no response", reply === undefined);
  t("and cannot change state", env.store.displayedFilm.permalink === "d");
}

// ---------------------------------------------------------------- H1 / H6 / M12 / M13
section("H1 / H6 / M12 / M13 — the booking handoff");
{
  const target = future(7);
  const pages = {
    1: [{ dateTime: future(1), seats: 2 }],
    2: [{ dateTime: future(4), seats: 2 }],
    3: [{ dateTime: target, seats: 5 }],
  };
  const fetchImpl = async (url) => {
    const m = /current_page=(\d+)/.exec(url);
    const page = m ? Number(m[1]) : 1;
    return ok(bfiHtml(pages[page] || [], { totalPages: 3 }));
  };
  const env = boot(fetchImpl);
  env.hooks.executeScript = (name) => (name === "clickBuyInPage" ? { ok: true } : true);

  const film = { title: "D", permalink: "d" };
  await env.api.setDisplayedFilm(film);
  // stored page is deliberately WRONG (says page 1, really on page 3)
  const res = await env.api.openScreening(film, { dateTime: target, page: 1 }, { focusOnFailure: false });
  t("handoff reports success", res.ok === true, res);
  t("H6: tab opens in the BACKGROUND", env.log.tabsCreated[0].active === false);
  t("M12: stale page corrected -> opens page 3 directly", /current_page=3/.test(env.log.tabsCreated[0].url), env.log.tabsCreated[0].url);
  t("M13: one navigation, no second load", env.log.tabsUpdated.filter((u) => u.url).length === 0, env.log.tabsUpdated);

  // H1: a screening that is not on the site must refuse, not guess
  const env2 = boot(fetchImpl);
  env2.hooks.executeScript = (name, args) => {
    if (name !== "clickBuyInPage") return true;
    return { ok: false, reason: "buy-link-not-found" };
  };
  await env2.api.setDisplayedFilm(film);
  const res2 = await env2.api.openScreening(film, { dateTime: "Sunday 1 January 2040 09:00", page: 1 }, { focusOnFailure: false });
  t("H1: unknown screening refuses", res2.ok === false && res2.reason === "buy-link-not-found", res2);
}

section("H6 — the popup path never steals focus on failure");
{
  const env = boot(async () => ok(bfiHtml([{ dateTime: future(2), seats: 1 }])));
  env.hooks.executeScript = (name) => (name === "clickBuyInPage" ? { ok: false, reason: "buy-link-not-found" } : true);
  await env.api.setDisplayedFilm({ title: "D", permalink: "d" });
  const r = await env.fire.message({ type: "OPEN_SCREENING", screening: { dateTime: future(2), page: 1 } });
  t("popup gets the failure reason back", r?.reason === "buy-link-not-found", r);
  const tab = [...env.tabs.values()].at(-1);
  t("the tab stays in the background", tab.active === false);
}

// ---------------------------------------------------------------- M3
section("M3 — a closed tab cannot hang the handoff");
{
  const env = boot(async () => ok(bfiHtml([{ dateTime: future(2), seats: 1 }])));
  let created = null;
  const origCreate = env.chrome.tabs.create;
  env.chrome.tabs.create = async (o) => {
    const tab = await origCreate(o);
    created = tab;
    // user closes it immediately, before it ever reaches "complete"
    tab.status = "loading";
    queueMicrotask(() => env.chrome.tabs.remove(tab.id));
    return tab;
  };
  env.hooks.executeScript = () => ({ ok: true });
  await env.api.setDisplayedFilm({ title: "D", permalink: "d" });
  const done = await Promise.race([
    env.api.openScreening({ title: "D", permalink: "d" }, { dateTime: future(2), page: 1 }),
    new Promise((r) => setTimeout(() => r("TIMED-OUT"), 3000)),
  ]);
  t("it resolves instead of hanging", done !== "TIMED-OUT", done);
  t("and reports a failure", done.ok === false, done);
}

section("M3 — the Cloudflare refresh window is always closed");
{
  let call = 0;
  const env = boot(async () => (++call <= 2 ? notFound : ok(bfiHtml([{ dateTime: future(2), seats: 1 }]))));
  await env.api.addWatch({ title: "D", permalink: "d" });
  await env.api.checkOneFilm({ title: "D", permalink: "d" });
  const created = env.log.windows.filter((w) => w.op === "create").length;
  const removed = env.log.windows.filter((w) => w.op === "remove").length;
  t("every refresh window it opened, it closed", created > 0 && created === removed, { created, removed });
  t("no window left behind", (await env.chrome.windows.getAll()).length === 0);
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
