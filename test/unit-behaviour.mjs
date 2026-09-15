import fs from "fs";
const bg = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");
const pj = fs.readFileSync(new URL("../popup.js", import.meta.url), "utf8");
const sh = fs.readFileSync(new URL("../shared.js", import.meta.url), "utf8");
const grab = (src, name) => {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error("not found: " + name);
  let d = 0;
  for (let k = src.indexOf("{", i); k < src.length; k++) {
    if (src[k] === "{") d++;
    else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1);
  }
};
let pass = 0, fail = 0;
const t = (n, c) => { c ? (pass++, console.log("  PASS", n)) : (fail++, console.log("  FAIL", n)); };

console.log("M4 pruneNotificationMap:");
const prune = new Function(`${grab(bg, "pruneNotificationMap")}
  ${grab(bg, "pruneNotificationMap").includes("NOTIFICATION_MAP_TTL_MS") ? "" : ""}
  return pruneNotificationMap;`.replace("NOTIFICATION_MAP_TTL_MS", "86400000"))();
const now = Date.now();
let map = {
  fresh: { createdAt: now - 1000 },
  old: { createdAt: now - 25 * 3600 * 1000 },
  legacy: { permalink: "x" },           // pre-fix entry, no timestamp
  edge: { createdAt: now - 23 * 3600 * 1000 },
};
prune(map);
t("keeps fresh entry", "fresh" in map);
t("keeps entry under 24h", "edge" in map);
t("drops entry over 24h", !("old" in map));
t("drops legacy untimestamped entry", !("legacy" in map));

console.log("M1 escapeHtml (shared.js):");
const esc = new Function(`${grab(sh, "escapeHtml")}; return escapeHtml;`)();
t("escapes angle brackets", esc('<img src=x onerror=1>') === "&lt;img src=x onerror=1&gt;");
t("escapes quotes and amp", esc(`a&b"c'd`) === "a&amp;b&quot;c&#39;d");
t("plain title unchanged", esc("Dune: Part Three") === "Dune: Part Three");
// the exact attack path M1 describes: BFI title containing &lt;img ...&gt;
const decode = new Function(`${grab(bg, "decodeHtmlEntities")}; return decodeHtmlEntities;`)();
const bfiTitle = "Film &lt;img src=x&gt;";
const decoded = decode(bfiTitle);
t("decodeHtmlEntities does produce a live tag", decoded === "Film <img src=x>");
t("escapeHtml neutralises it again", esc(decoded) === "Film &lt;img src=x&gt;");

console.log("M6 batching threshold:");
t("single screening uses notify()", /newlyAvailable\.length === 1[\s\S]{0,80}await notify\(film, newlyAvailable\[0\]\)/.test(bg));
t("multiple uses notifyBatch()", /else \{\s*await notifyBatch\(film, newlyAvailable\)/.test(bg));

console.log("M5 badge:");
t("checkAllWatched accumulates", /if \(totalAlerts > 0\) await addUnseenAlerts\(totalAlerts\)/.test(bg));
t("CHECK_NOW accumulates", /if \(count > 0\) await addUnseenAlerts\(count\)/.test(bg));
t("pagehide listener removed", !/addEventListener\("pagehide"/.test(pj));
  t("popup no longer writes the badge", !/setBadgeText/.test(pj));
  t("popup uses shared escapeHtml, no local copy", !/function escapeHtml/.test(pj) && /function escapeHtml/.test(sh));
t("popup reports ALERTS_SEEN", /ALERTS_SEEN/.test(pj) && /ALERTS_SEEN/.test(bg));

console.log("L1/L6 - the default interval agrees everywhere:");
{
  const oj = fs.readFileSync(new URL("../options.js", import.meta.url), "utf8");
  const oh = fs.readFileSync(new URL("../options.html", import.meta.url), "utf8");
  const bgDefault = /DEFAULT_INTERVAL_MINUTES = (\d+)/.exec(bg)?.[1];
  const shDefault = /DEFAULT_INTERVAL_MINUTES = (\d+)/.exec(sh)?.[1];
  const htmlDefault = /id="intervalMinutes"[^>]*value="(\d+)"/.exec(oh)?.[1];
  t("background.js and shared.js agree", bgDefault === shDefault, { bgDefault, shDefault });
  t("the options.html field matches", htmlDefault === bgDefault, { htmlDefault, bgDefault });
  // the field must be populated through the shared clamp, never a hardcoded fallback
  t("options.js shows the real default, not '|| 1'",
    /intervalMinutes"\)\.value = clampIntervalMinutes\(/.test(oj) && !/stored\.intervalMinutes \|\| \d/.test(oj));
}

console.log("M8 permission:");
const mf = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
t("tabs permission gone", !mf.permissions.includes("tabs"));
t("windows permission gone", !mf.permissions.includes("windows"));
t("scripting retained", mf.permissions.includes("scripting"));
t("only info.status read from onUpdated", /info\.status === "complete"/.test(bg) && !/info\.url/.test(bg));

console.log("M7:");
t("switchDisplayedFilm hides flash", /switchDisplayedFilm[\s\S]{0,200}bellFlash"\)\.hidden = true/.test(pj));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
