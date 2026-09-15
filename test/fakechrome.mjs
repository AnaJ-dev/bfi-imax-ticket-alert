// A fake Chrome extension environment good enough to actually RUN background.js.
export function makeChrome() {
  const store = {};
  const changedListeners = [];
  const msgListeners = [];
  const notifClicked = [];
  const notifClosed = [];
  const tabUpdated = [];
  const tabRemoved = [];
  const alarmListeners = [];

  const log = { badge: [], notifications: [], tabsCreated: [], tabsUpdated: [], executed: [], windows: [] };
  let nextTabId = 100, nextWinId = 1;
  const tabs = new Map();
  const windows = new Map();
  const alarms = new Map();

  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  const chrome = {
    runtime: {
      id: "test-extension-id",
      lastError: undefined,
      getURL: (p) => "chrome-extension://test/" + p,
      onMessage: { addListener: (fn) => msgListeners.push(fn) },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
    },
    storage: {
      local: {
        async get(keys) {
          if (keys === null || keys === undefined) return clone(store);
          if (typeof keys === "string") return { [keys]: clone(store[keys]) };
          if (Array.isArray(keys)) {
            const out = {};
            for (const k of keys) if (k in store) out[k] = clone(store[k]);
            return out;
          }
          const out = { ...keys };
          for (const k of Object.keys(keys)) if (k in store) out[k] = clone(store[k]);
          return out;
        },
        async set(obj) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: clone(store[k]), newValue: clone(v) };
            store[k] = clone(v);
          }
          changedListeners.forEach((fn) => fn(changes, "local"));
        },
        async remove(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          const changes = {};
          for (const k of list) { changes[k] = { oldValue: clone(store[k]) }; delete store[k]; }
          changedListeners.forEach((fn) => fn(changes, "local"));
        },
        async clear() { for (const k of Object.keys(store)) delete store[k]; },
      },
      onChanged: { addListener: (fn) => changedListeners.push(fn) },
    },
    action: {
      setBadgeText: (o) => log.badge.push(o.text),
      setBadgeBackgroundColor: () => {},
      getUserSettings: async () => ({ isOnToolbar: false }),
    },
    alarms: {
      create: (name, opts) => { alarms.set(name, opts); },
      clear: (name) => alarms.delete(name),
      getAll: async () => [...alarms.entries()].map(([name, o]) => ({ name, ...o })),
      onAlarm: { addListener: (fn) => alarmListeners.push(fn) },
    },
    notifications: {
      create: (id, opts, cb) => { log.notifications.push({ id, ...opts }); cb && cb(id); },
      clear: (id) => { log.notifications = log.notifications.filter((n) => n.id !== id); },
      getPermissionLevel: (cb) => cb("granted"),
      onClicked: { addListener: (fn) => notifClicked.push(fn) },
      onClosed: { addListener: (fn) => notifClosed.push(fn) },
    },
    tabs: {
      create: async ({ url, active }) => {
        const id = nextTabId++;
        const t = { id, url, active, status: "loading", windowId: nextWinId };
        tabs.set(id, t);
        log.tabsCreated.push({ id, url, active });
        queueMicrotask(() => { t.status = "complete"; tabUpdated.forEach((fn) => fn(id, { status: "complete" }, t)); });
        return t;
      },
      // Chrome supports BOTH forms; waitForTabComplete uses the callback form and
      // relies on runtime.lastError when the tab is gone.
      get: (id, cb) => {
        const missing = !tabs.has(id);
        if (cb) {
          chrome.runtime.lastError = missing ? { message: "No tab with id: " + id } : undefined;
          cb(missing ? undefined : tabs.get(id));
          chrome.runtime.lastError = undefined;
          return;
        }
        if (missing) return Promise.reject(new Error("No tab with id: " + id));
        return Promise.resolve(tabs.get(id));
      },
      update: async (id, props) => {
        const t = tabs.get(id);
        if (!t) throw new Error("No tab with id: " + id);
        Object.assign(t, props);
        log.tabsUpdated.push({ id, ...props });
        if (props.url) {
          t.status = "loading";
          queueMicrotask(() => { t.status = "complete"; tabUpdated.forEach((fn) => fn(id, { status: "complete" }, t)); });
        }
        return t;
      },
      remove: async (id) => { tabs.delete(id); tabRemoved.forEach((fn) => fn(id)); },
      onUpdated: { addListener: (fn) => tabUpdated.push(fn), removeListener: (fn) => { const i = tabUpdated.indexOf(fn); if (i >= 0) tabUpdated.splice(i, 1); } },
      onRemoved: { addListener: (fn) => tabRemoved.push(fn), removeListener: (fn) => { const i = tabRemoved.indexOf(fn); if (i >= 0) tabRemoved.splice(i, 1); } },
    },
    windows: {
      create: async ({ url }) => {
        const id = nextWinId++;
        const tabId = nextTabId++;
        const t = { id: tabId, url, status: "loading", windowId: id };
        tabs.set(tabId, t);
        const w = { id, tabs: [t] };
        windows.set(id, w);
        log.windows.push({ op: "create", id });
        queueMicrotask(() => { t.status = "complete"; tabUpdated.forEach((fn) => fn(tabId, { status: "complete" }, t)); });
        return w;
      },
      remove: async (id) => { windows.delete(id); log.windows.push({ op: "remove", id }); },
      update: async () => {},
      getAll: async () => [...windows.values()],
    },
    scripting: {
      executeScript: async ({ target, func, args }) => {
        log.executed.push(func.name);
        return [{ result: hooks.executeScript ? hooks.executeScript(func.name, args, target) : undefined }];
      },
    },
  };

  const hooks = { executeScript: null };

  return {
    chrome, store, log, hooks,
    tabs, windows,
    fire: {
      message: (msg, sender = { id: "test-extension-id" }) =>
        new Promise((resolve) => {
          let answered = false;
          for (const fn of msgListeners) {
            const kept = fn(msg, sender, (r) => { answered = true; resolve(r); });
            if (kept === true) return;
          }
          if (!answered) resolve(undefined);
        }),
      notificationClosed: (id) => Promise.all(notifClosed.map((fn) => fn(id))),
      notificationClicked: (id) => Promise.all(notifClicked.map((fn) => fn(id))),
      alarm: (name) => Promise.all(alarmListeners.map((fn) => fn({ name }))),
    },
  };
}

// Build HTML that background.js's parsePage can actually parse.
export function bfiHtml(screenings, { totalPages = 1, sToken = "TOK", articleId = "ART" } = {}) {
  const rows = screenings
    .map((s) => `"${s.dateTime}", "a","b","c","d","e","f","g","h", "${s.seats}"`)
    .join(",\n");
  return `<html><head><a href="?sToken=${sToken}&x=1">t</a></head><body>
    var cfg = { articleId: "${articleId}", total_pages: "${totalPages}" };
    searchResults : [ ${rows} ] searchLabels : []
  </body></html>`;
}
