import fs from "fs";
const bg = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");
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

console.log("L6 clampIntervalMinutes (shared.js and background.js agree):");
const mk = (src) => new Function(`const DEFAULT_INTERVAL_MINUTES=5,MIN_INTERVAL_MINUTES=1,MAX_INTERVAL_MINUTES=60;
  ${grab(src, "clampIntervalMinutes")}; return clampIntervalMinutes;`)();
const cs = mk(sh), cb = mk(bg);
for (const [inp, want] of [[0,1],[1,1],[5,5],[60,60],[61,60],[999,60],[-5,1],["7",7],[null,5],[undefined,5],["abc",5],[NaN,5],[3.6,4]]) {
  const a = cs(inp), b = cb(inp);
  t(`clamp(${JSON.stringify(inp)}) = ${want} in both`, a === want && b === want);
}

console.log("L2 allScreeningsPast:");
const past = new Function(`${grab(bg,"parseScreeningDate")}; ${grab(bg,"allScreeningsPast")}; return allScreeningsPast;`)();
const fmt = (d) => {
  const days=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const mon=["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${days[d.getDay()]} ${d.getDate()} ${mon[d.getMonth()]} ${d.getFullYear()} 19:00`;
};
const ago = (n) => fmt(new Date(Date.now() - n*864e5));
const ahead = (n) => fmt(new Date(Date.now() + n*864e5));
t("empty list is NOT 'all past'", past([]) === false);
t("all past detected", past([{dateTime:ago(30)},{dateTime:ago(2)}]) === true);
t("one future keeps it alive", past([{dateTime:ago(30)},{dateTime:ahead(5)}]) === false);
t("all future keeps it alive", past([{dateTime:ahead(1)},{dateTime:ahead(9)}]) === false);
t("unparseable date does not retire the film", past([{dateTime:"not a date"}]) === false);

console.log("M12/M13 resolveScreeningUrl (hint-first ordering):");
const src = grab(bg, "resolveScreeningUrl");
const fetched = [];
const run = async (hintPage, holderPage, totalPages=6) => {
  fetched.length = 0;
  const fn = new Function("fetchPage","pageUrl","MAX_PAGES", `return ${"async " + src}`)(
    async (u) => {
      fetched.push(u);
      const page = u.startsWith("P") ? Number(u.slice(1)) : 1;
      return { screenings: page === holderPage ? [{dateTime:"TARGET"}] : [{dateTime:"other"}],
               totalPages, sToken:"tok", articleId:"aid" };
    },
    (tok,aid,page) => `P${page}`, 30);
  return fn("BASE", "TARGET", hintPage);
};
t("finds target on page 1", await run(1,1) === "BASE");
t("hint page checked first", (await run(4,4)) === "P4" && fetched.join(",") === "BASE,P4");
t("stale hint still finds real page", (await run(4,2)) === "P2" && fetched[1] === "P4" && fetched[2] === "P2");
t("no hint scans in order", (await run(undefined,3)) === "P3" && fetched.join(",") === "BASE,P2,P3");
t("target absent everywhere -> null", (await run(2,99)) === null);
t("hint beyond totalPages ignored", (await run(50,2)) === "P2");

console.log("L11 logging:");
t("routine logs behind flag", !/console\.log\("BFI/.test(bg) && /function log\(/.test(bg));
t("all console.error kept", (bg.match(/console\.error/g)||[]).length >= 4);

console.log("L7:");
t("sender checked", /sender\.id !== chrome\.runtime\.id/.test(bg));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
